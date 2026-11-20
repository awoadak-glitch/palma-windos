const endpoint='/api/desktop/updates';
export async function reportDesktopReady(){
  if(location.protocol==='palma:')try{await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'ready'})});}catch{}
}
export function renderDesktopUpdates(container){
  if(location.protocol!=='palma:'){container.textContent='التحديثات متاحة في تطبيق بالما للكمبيوتر.';return;}
  container.innerHTML=`<section class="update-panel info-panel"><h2>تحديث بالما</h2><p id="update-version">جاري قراءة الإصدار…</p><form id="update-config"><label for="update-repository">مستودع التحديثات على GitHub</label><div class="update-config-row"><input id="update-repository" dir="ltr" placeholder="https://github.com/awoadak-glitch/PALMA" autocomplete="off" required><button class="btn outline" type="submit">حفظ</button></div><p>استخدم رابط المستودع المخصص لتحديثات بالما. يجب أن تكون إصداراته متاحة للتنزيل العام.</p></form><p id="update-startup" role="status"></p><p id="update-status" role="status" aria-live="polite"></p><progress id="update-progress" max="100" value="0" hidden></progress><p id="update-bytes"></p><pre id="update-notes"></pre><div class="update-actions"><button id="update-check" class="btn outline">التحقق من التحديث</button><button id="update-download" class="btn primary" hidden>تنزيل التحديث</button><button id="update-restart" class="btn primary" hidden>إعادة التشغيل وتثبيت التحديث</button><button id="update-cancel" class="btn outline" hidden>إلغاء التنزيل</button></div><p>تُحفظ إعداداتك والمفضلة وموضع المشاهدة عند التحديث.</p></section>`;
  const panel=container.querySelector('.update-panel'),el=id=>panel.querySelector('#'+id);let locked=false,clientError='';
  const busyPhases=['checking','downloading','verifying'];
  function draw(s){
    const busy=busyPhases.includes(s.phase);el('update-version').textContent='الإصدار الحالي: '+s.version;
    if(document.activeElement!==el('update-repository'))el('update-repository').value=s.repository?'https://github.com/'+s.repository:'';
    el('update-config').querySelector('button').disabled=busy||Boolean(s.pending);el('update-repository').disabled=busy||Boolean(s.pending);
    el('update-check').disabled=busy||!s.configured||Boolean(s.pending);
    el('update-download').hidden=!s.available||Boolean(s.pending)||busy;
    el('update-restart').hidden=!s.pending;el('update-cancel').hidden=!busy;
    const messages={idle:s.configured?'يمكنك التحقق من وجود إصدار جديد.':'أدخل رابط مستودع تحديثات بالما لبدء التحديث.',checking:'جارٍ التحقق من GitHub…',available:'يتوفر الإصدار '+(s.available?.version||''),current:'أنت تستخدم أحدث إصدار منشور.',downloading:'جارٍ تنزيل التحديث…',verifying:'جارٍ التحقق من سلامة التحديث…',ready:'اكتمل التنزيل. أعد تشغيل بالما لتثبيت التحديث.',error:s.error};
    el('update-status').textContent=clientError||(s.pending?'التحديث '+s.pending+' جاهز للتثبيت.':messages[s.phase]||'');
    el('update-startup').textContent=s.startupMessage||'';el('update-notes').textContent=s.available?.notes||'';
    el('update-progress').hidden=!['downloading','verifying'].includes(s.phase);el('update-progress').value=s.total?Math.round(s.bytes/s.total*100):0;
    el('update-bytes').textContent=s.total?`${(s.bytes/1048576).toFixed(1)} / ${(s.total/1048576).toFixed(1)} MB`:'';
  }
  async function send(action,extra={}){
    if(locked)return;locked=true;clientError='';
    try{
      el('update-status').textContent=action==='check'?'جارٍ التحقق من GitHub…':action==='restart'?'جارٍ إعادة تشغيل بالما…':'جارٍ تنفيذ الطلب…';
      const r=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...extra})});const s=await r.json();
      if(!r.ok)throw Error(s.error||'تعذر تنفيذ التحديث.');if(!s.restarting)draw(s);
    }catch(e){clientError=e.message;el('update-status').textContent=e.message;}finally{locked=false;}
  }
  el('update-config').onsubmit=e=>{e.preventDefault();send('configure',{repository:el('update-repository').value});};
  for(const action of ['check','download','restart','cancel'])el('update-'+action).onclick=()=>send(action);
  async function poll(){
    if(!panel.isConnected)return;
    if(!locked)try{const r=await fetch(endpoint,{cache:'no-store'});if(r.ok)draw(await r.json());}catch{}
    if(panel.isConnected)setTimeout(poll,800);
  }
  poll();
}
