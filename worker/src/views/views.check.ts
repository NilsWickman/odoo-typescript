/** Dynamic native differential checks. Run npm run test:views with ODOO_TEST_DB. */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Cursor } from '../db';
import type { Env } from '../env';
import { createEnvironment } from '../orm/env';
import { setGenMetadataLoader, type GenMetadata } from '../orm/registry';
import type { Context } from '../orm/types';
import { getViews } from '../web/get_views';
import { callKw } from '../http/methods';
import { internationalPhone } from '../models/phone';
import { MailBootstrap } from '../mail/bootstrap';
import { initChannels, channelCounters } from '../mail/channels';
import { Store } from '../mail/store';
import { parseDomain } from '../orm/domain';
import { failures, activityGroups } from '../mail/menu';
import { fetchMessages,threadFields,messageFields } from '../mail/thread';
import '../web/search_read';
import '../models/partner';
import '../models/filters';
import '../models/partner_read';
import '../models/partner_form';

const db=process.env['ODOO_TEST_DB'], path=process.env['ODOO_VIEWS_ORACLE'];
if(!db||!/^(dev_|live_|run_)[\w]+$/.test(db)||!path) throw new Error('Run test/views.sh with ODOO_TEST_DB set to a scratch database.');
setGenMetadataLoader(async()=>{
  const data=JSON.parse(readFileSync(new URL('../../gen/out/models.json',import.meta.url).pathname,'utf8')) as {models:GenMetadata};
  return data.models;
});
interface RpcRequest {model:string;method:string;args:unknown[];kwargs:Record<string,unknown>}
interface Case {login:string;uid:number;context:Context;views:[number|false,string][];options:Record<string,unknown>;fields:unknown;result:unknown;request:RpcRequest;contacts:unknown;bootstrap:Record<string,unknown>;initial_channels:Record<string,unknown>;counters:Record<string,unknown>;tabs:Record<string,unknown>;failures:Record<string,unknown>;activities:Record<string,unknown>;form_request:RpcRequest;form:unknown;chatter:{id:number;data_id:number;fetch:Record<string,unknown>;request_list:string[];result:Record<string,unknown>}[];searches:{domain:unknown;ids:number[]}[]}
const {cases,phones}=JSON.parse(readFileSync(path,'utf8')) as {cases:Case[];phones:[string,string][]};
for(const item of cases) test(`native fields_get/get_views: ${item.login}, ${item.context.lang}`,async()=>{
  const cr=new Cursor({SLOTS:'{}',PG_DSN_TEMPLATE:'postgresql://track_rw:track_rw@127.0.0.1:5433/{db}'} as Env,db);
  try {
    const env=await createEnvironment({cr,uid:item.uid,context:item.context});
    assert.deepEqual(await env.model('res.partner').fieldsGet(null,env.reg.model('res.partner').viewFieldAttributes),item.fields);
    assert.deepEqual(await getViews(env,'res.partner',item.views,item.options),item.result);
    const req=item.request;
    assert.deepEqual(await callKw(env,req.model,req.method,req.args,req.kwargs),item.contacts);
    const setting=(await cr.query<{id:number}>('SELECT id FROM res_users_settings WHERE user_id=$1 ORDER BY id LIMIT 1',[item.uid])).rows[0];
    assert.ok(setting,'test user settings must exist');
    const actual=await(await new MailBootstrap(env).init(setting.id)).asDict(cr);
    // Snapshots belong to distinct transactions; compare all Store data exactly.
    const withoutVersion=({__store_version__:_,...values}:Record<string,unknown>)=>values;
    assert.deepEqual(withoutVersion(actual),withoutVersion(item.bootstrap));
    const channels=new Store();await initChannels(env,channels);
    assert.deepEqual(withoutVersion(await channels.asDict(cr)),withoutVersion(item.initial_channels));
    const counters=new Store();await channelCounters(env,counters,item.tabs);
    assert.deepEqual(withoutVersion(await counters.asDict(cr)),withoutVersion(item.counters));
    const failureStore=new Store();await failures(env,failureStore);
    assert.deepEqual(withoutVersion(await failureStore.asDict(cr)),withoutVersion(item.failures));
    const activityStore=new Store();await activityGroups(env,activityStore);
    assert.deepEqual(withoutVersion(await activityStore.asDict(cr)),withoutVersion(item.activities));
    const form=item.form_request;
    const normalize=(value:unknown)=>JSON.parse(JSON.stringify(value).replace(/(<function [^>]+ at )0x[0-9a-f]+/g,'$10x0')) as unknown;
    assert.deepEqual(normalize(await callKw(env,form.model,form.method,form.args,form.kwargs)),normalize(item.form));
    for(const c of item.chatter){
      const s=new Store(),ids=await fetchMessages(env,c.id,c.fetch,s,c.data_id);
      await threadFields(env,c.id,c.request_list,s);await messageFields(env,ids,s);
      assert.deepEqual(withoutVersion(await s.asDict(cr)),withoutVersion(c.result),`chatter ${c.id}`);
    }
    for(const s of item.searches)assert.deepEqual(await env.model('res.partner').search(parseDomain(s.domain)),s.ids);
  } finally {await cr.rollback();await cr.close();}
});
test('international phone formatting matches native library examples and stored numbers',async()=>{
  const differences:unknown[]=[];
  for(const [number,expected] of phones) {
    const actual=await internationalPhone(number);
    if(actual!==expected) differences.push({number,expected,actual});
  }
  assert.deepEqual(differences,[]);
});
