from pathlib import Path
import argparse, gzip, hashlib, json, re, shutil, struct, tempfile, zipfile

ROOT = Path(__file__).resolve().parent.parent

def digest(data):
    return hashlib.sha256(data).hexdigest()

def pack(source):
    header = {'files': {}}
    chunks = []
    offset = 0
    for file in sorted(source.rglob('*')):
        if not file.is_file():
            continue
        relative = file.relative_to(source)
        if file.is_symlink() or any(x.startswith('.') for x in relative.parts):
            raise ValueError('Unexpected hidden file or symlink: ' + str(relative))
        data = file.read_bytes()
        node = header['files']
        for part in relative.parts[:-1]:
            node = node.setdefault(part, {'files': {}})['files']
        block = 4 * 1024 * 1024
        node[relative.name] = {'size': len(data), 'offset': str(offset), 'integrity': {
            'algorithm': 'SHA256', 'hash': digest(data), 'blockSize': block,
            'blocks': [digest(data[n:n + block]) for n in range(0, len(data), block)]}}
        offset += len(data)
        chunks.append(data)
    raw = json.dumps(header, ensure_ascii=False, separators=(',', ':')).encode()
    padding = (-len(raw)) % 4
    encoded = struct.pack('<II', 4 + len(raw) + padding, len(raw)) + raw + b'\0' * padding
    archive = struct.pack('<II', 4, len(encoded)) + encoded + b''.join(chunks)
    # Independently verify every file's range, contents and digest.
    decoded = json.loads(archive[16:16 + struct.unpack_from('<I', archive, 12)[0]])
    base = 8 + struct.unpack_from('<I', archive, 4)[0]
    def verify(entries, prefix=Path()):
        for name, item in entries.items():
            relative = prefix / name
            if 'files' in item:
                verify(item['files'], relative)
            else:
                start = base + int(item['offset'])
                data = archive[start:start + item['size']]
                assert data == (source / relative).read_bytes()
                assert digest(data) == item['integrity']['hash']
    verify(decoded['files'])
    return archive

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--version', required=True)
    parser.add_argument('--repository', default='')
    parser.add_argument('--output', type=Path, default=ROOT / 'dist')
    args = parser.parse_args()
    version = args.version
    if not re.fullmatch(r'(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})', version):
        raise ValueError('Invalid version')
    if args.repository and not re.fullmatch(r'awoadak-glitch/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}', args.repository):
        raise ValueError('Use a repository owned by awoadak-glitch')
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    release = json.loads((ROOT / 'release.json').read_text(encoding='utf-8'))
    with tempfile.TemporaryDirectory() as temporary:
        app = Path(temporary) / 'app'
        shutil.copytree(ROOT / 'app', app)
        pkg = json.loads((app / 'package.json').read_text())
        pkg['version'] = version
        (app / 'package.json').write_text(json.dumps(pkg, indent=2) + '\n', encoding='utf-8')
        (app / 'web/public/version.json').write_text(json.dumps({'version': version, 'changes': release['notes']}, ensure_ascii=False), encoding='utf-8')
        (app / 'update-config.json').write_text(json.dumps({'repository': args.repository, 'runtime': 'palma-win-x64-v1'}, indent=2), encoding='utf-8')
        archive = pack(app)
    compressed = gzip.compress(archive, compresslevel=9, mtime=0)
    filename = f'PALMA-VISION-{version}.asar.gz'
    (output / filename).write_bytes(compressed)
    manifest = {'schema': 1, 'app': 'com.palma.vision.desktop', 'version': version,
                'runtime': 'palma-win-x64-v1', 'minBootstrap': 1,
                'url': f'https://github.com/{args.repository}/releases/download/v{version}/{filename}' if args.repository else '',
                'size': len(compressed), 'sha256': digest(compressed),
                'unpackedSize': len(archive), 'unpackedSha256': digest(archive), 'notes': release['notes']}
    (output / 'palma-update.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    (output / 'release-notes.txt').write_text(release['notes'], encoding='utf-8')
    installer = (ROOT / 'scripts/INSTALL-PALMA-UPDATE.bat').read_text(encoding='utf-8').replace('@ARCHIVE_SHA256@', digest(archive)).replace('@VERSION@', version)
    readme = f'''PALMA VISION {version}\n\nتثبيت ميزة التحديث للمرة الأولى:\n1. أغلق بالما بالكامل.\n2. فك ضغط هذه الحزمة.\n3. انسخ INSTALL-PALMA-UPDATE.bat ومجلد resources إلى المجلد الذي يحتوي PALMA VISION.exe.\n4. شغّل INSTALL-PALMA-UPDATE.bat ثم افتح بالما.\n5. افتح الإعدادات > تحديث بالما. مصدر التحديث مدمج وجاهز تلقائيًا.\n6. اضغط التحقق من التحديث، ثم تنزيل، ثم إعادة التشغيل والتثبيت.\n\nيحتفظ المثبت بنسخة احتياطية من app.asar داخل resources.\nلا تحذف مجلد بيانات بالما؛ فيه المفضلة والسجل وهوية الجهاز.\nالمستودع يجب أن يحتوي إصدار GitHub Release عامًا وملف palma-update.json.\nملفات المشروع تتضمن workflow يبني الإصدار عند تعديل app على فرع main.\nتغيير أوسكار يحتاج تعديل كود بالما أولًا؛ زر التحديث ينزّل الإصلاح المنشور.\nحزم التحديث تحدث كود التطبيق، ومحرك Electron يبقى كما هو.\n'''
    setup = output / f'PALMA-VISION-{version}-Update-Setup.zip'
    with zipfile.ZipFile(setup, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr('resources/palma-update.asar', archive)
        z.writestr('INSTALL-PALMA-UPDATE.bat', installer.replace('\r\n', '\n').replace('\n', '\r\n').encode('ascii'))
        z.writestr('READ-ME-AR.txt', readme.encode('utf-8-sig'))
    with zipfile.ZipFile(setup) as z:
        assert z.testzip() is None and z.read('resources/palma-update.asar') == archive
    print(json.dumps({'version': version, 'setup_bytes': setup.stat().st_size, 'update_bytes': len(compressed), 'archive_sha256': digest(archive)}))

if __name__ == '__main__':
    main()
