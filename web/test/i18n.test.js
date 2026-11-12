import assert from 'node:assert/strict';
import { test } from 'node:test';
const i18n = await import('../js/i18n.js').catch(() => ({}));

test('browser preference uses valid storage, otherwise device language with English fallback', () => {
  assert.equal(typeof i18n.resolveLanguage, 'function');
  for (const [saved, device, expected] of [[null,'es-MX','es'],[null,'en-US','en'],[null,'fr','en'],['en','es','en'],['es','en','es'],['bad','es-ES','es']]) {
    assert.equal(i18n.resolveLanguage({storage:{getItem:()=>saved},deviceLanguage:device}),expected);
  }
  assert.equal(i18n.resolveLanguage({storage:{getItem(){throw Error('blocked');}},deviceLanguage:'es'}),'es');
});
test('live selection persists only valid choices and subscriptions unsubscribe', () => {
  assert.equal(typeof i18n.setLanguage, 'function');
  i18n.setLanguage('en');
  const seen = [];
  const unsubscribe = i18n.onLanguageChange(language => seen.push(language));
  i18n.setLanguage('es'); i18n.setLanguage('es'); i18n.setLanguage('invalid');
  assert.equal(i18n.getLanguage(),'es'); assert.deepEqual(seen,['es']);
  unsubscribe(); i18n.setLanguage('en'); assert.deepEqual(seen,['es']);
});
test('catalog interpolation preserves user content as literal text and languages differ', () => {
  assert.equal(typeof i18n.t, 'function');
  i18n.setLanguage('en');
  assert.equal(i18n.t('pilotLine',{pilot:'<b>Ana</b>',standby:'$& {pilot}'}),'Pilot: <b>Ana</b> · Standby: $& {pilot}');
  i18n.setLanguage('es');
  assert.equal(i18n.t('pilotLine',{pilot:'Ana',standby:'Luis'}),'Piloto: Ana · En espera: Luis');
  assert.equal(i18n.t('unknown.key'),'unknown.key');
});
test('blocked browser storage cannot break a live language change', () => {
  assert.equal(typeof i18n.setLanguage, 'function');
  const old = globalThis.window;
  globalThis.window = {get localStorage(){throw Error('blocked');}};
  try { assert.doesNotThrow(()=>i18n.setLanguage('en')); assert.equal(i18n.getLanguage(),'en'); }
  finally { if(old === undefined) delete globalThis.window; else globalThis.window=old; }
});
test('pilot and admin helper messages follow live selection, preserving safety decisions', async () => {
  const {stateLabel, recoverySteps, queueText} = await import('../js/view.js');
  const {rowActions} = await import('../js/adminview.js');
  const status={core:true,state:'FAILSAFE',fcArm:'armed',cmdAgeMs:10};
  i18n.setLanguage('es');
  assert.equal(stateLabel({core:true,state:'ARMED'},true),'ARMADO');
  assert.match(rowActions({name:'Ana',flying:true},'Luis').reason,/volando/);
  const before=recoverySteps({status,engaged:true});
  i18n.setLanguage('en');
  assert.equal(stateLabel({core:true,state:'ARMED'},true),'ARMED');
  assert.equal(rowActions({name:'Ana',flying:true},'Luis').reason,'Flying: cannot be removed');
  assert.deepEqual(recoverySteps({status,engaged:true}).map(s=>s.state),before.map(s=>s.state));
  assert.equal(queueText({role:'queued',lost:true},{pilotName:'<img onerror=bad()>'}),'Control lost: <img onerror=bad()> is now flying');
});
test('language changes persist on this browser even when the current selection is repeated', () => {
  const old=globalThis.window, data={};
  globalThis.window={localStorage:{setItem:(key,value)=>{data[key]=value;}}};
  try {
    i18n.setLanguage('es'); i18n.setLanguage('es');
    assert.deepEqual(data,{'gcs.language':'es'});
    i18n.setLanguage('fr'); assert.deepEqual(data,{'gcs.language':'es'});
  } finally { if(old === undefined) delete globalThis.window; else globalThis.window=old; }
});

test('marked labels and accessibility attributes update while user content stays untouched', () => {
  const label={dataset:{i18n:'pilotLine'},textContent:''};
  const user={textContent:'<b>ana</b>'};
  const attributes={'data-i18n-aria-label':'language','aria-label':''};
  const control={value:'',events:{},getAttribute:key=>attributes[key],setAttribute:(key,value)=>{attributes[key]=value;},addEventListener:(name,handler)=>{control.events[name]=handler;}};
  const doc={documentElement:{lang:''},querySelectorAll:selector=>selector==='[data-i18n]'?[label]:selector==='[data-i18n-aria-label]'||selector==='[data-language-select]'?[control]:[]};
  i18n.setLanguage('es'); i18n.initLanguageUI(doc);
  assert.equal(doc.documentElement.lang,'es'); assert.equal(attributes['aria-label'],'Idioma');
  control.value='en';control.events.change();
  assert.equal(doc.documentElement.lang,'en'); assert.equal(attributes['aria-label'],'Language');
  assert.equal(label.textContent,'Pilot: {pilot} · Standby: {standby}');
  assert.equal(user.textContent,'<b>ana</b>');
  i18n.initLanguageUI(doc); // idempotent setup must not duplicate listeners or replace controls
  assert.equal(control.value,'en');
});
