/** Odoo _phone_get_formatted for canonical stored E164 numbers. The metadata
 * comes from phonenumbers, not corpus values (gen/phone.py). Parsing arbitrary
 * user input is outside this read path and explicitly unsupported. */
import { NotPorted, UserError } from '../errors';
import { registerHooks } from '../orm/hooks';
import { cond, or, TRUE } from '../orm/domain';
import type { Environment,Domain } from '../orm/types';

interface Description {pattern:string|null;lengths:number[];local_lengths?:number[]}
interface Metadata {general:Description;leading:string|null;country_code:number;international_prefix:string|null;national_prefix:string|null;national_transform:string|null;types:Description[];formats:{pattern:string;format:string;leading:string|null}[]}
interface PhoneData {calling_codes:Record<string,string[]>;regions:Record<string,Metadata>;non_geographic:Record<string,Metadata>}
let data:Promise<PhoneData>|undefined;
const full=(pattern:string|null,value:string):boolean=>!!pattern&&new RegExp(`^(?:${pattern})$`).test(value);
const matches=(desc:Description,number:string):boolean=>(!desc.lengths.length||desc.lengths.includes(number.length))&&full(desc.pattern,number);
const valid=(meta:Metadata,number:string):boolean=>matches(meta.general,number)&&meta.types.some(d=>matches(d,number));

/** phonenumberutil.py _test_number_length for the general description (type UNKNOWN). */
function lengthResult(meta:Metadata,number:string):'possible'|'local'|'short'|'long'|'invalid'{
  const possible=meta.general.lengths,local=meta.general.local_lengths??[],n=number.length;
  if(!possible.length||possible[0]===-1)return 'invalid';
  if(local.includes(n))return 'local';
  if(possible[0]===n)return 'possible';
  if(possible[0]!>n)return 'short';
  if(possible[possible.length-1]!<n)return 'long';
  return possible.slice(1).includes(n)?'possible':'invalid';
}
/**
 * phonenumberutil.py _maybe_strip_national_prefix_carrier_code, and _parse's use of it: the national prefix (or its
 * transform) taken off when the original is not a viable national number or the result is, and kept only when the
 * result's length is not too short, local-only or invalid. Applied to the national number of a "+CC ..." input too,
 * with the metadata of the code's main region ("+32 010 12 34 56" is +3210123456).
 */
function stripNationalPrefix(meta:Metadata,number:string):string{
  if(!number||!meta.national_prefix)return number;
  const re=new RegExp(`^(?:${meta.national_prefix})`),match=re.exec(number);
  if(!match)return number;
  const viable=full(meta.general.pattern,number),groups=match.length-1;
  let candidate:string;
  if(!meta.national_transform||(groups>0&&match[groups]===undefined)){
    candidate=number.slice(match[0].length);
  }else{
    if(groups===0)throw new NotPorted('phone national prefix transform without a group');
    candidate=number.replace(re,meta.national_transform.replace(/\\(\d+)/g,'$$$1'));
  }
  if(viable&&!full(meta.general.pattern,candidate))return number;
  const r=lengthResult(meta,candidate);
  return r==='short'||r==='local'||r==='invalid'?number:candidate;
}

/** phonenumberutil.parse's numeric prefix path. Vanity numbers and extensions
 * still refuse explicitly. phone_validation.phone_parse validates the result. */
export async function canonicalPhone(input:string|null,region:string|null):Promise<string|false>{
  if(!input)return false;
  if(!/^[+\d\s()./\-]+$/.test(input))throw new NotPorted('phone parsing of letters/extensions');
  data??=import('../../gen/out/phone.json',{with:{type:'json'}}).then(m=>m.default);
  const tables=await data;
  let number=input.replace(/[\s()./\-]/g,''),meta=region?tables.regions[region]:undefined;
  if(!number.startsWith('+')){
    if(!meta)return false;
    if(meta.international_prefix){const prefix=new RegExp(`^(?:${meta.international_prefix})`).exec(number);if(prefix&&number[prefix[0].length]!=='0')number='+'+number.slice(prefix[0].length);}
  }
  if(!number.startsWith('+')){
    if(!meta)return false;
    const code=String(meta.country_code);
    if(number.startsWith(code)&&!matches(meta.general,number)&&matches(meta.general,number.slice(code.length)))number=number.slice(code.length);
    number=stripNationalPrefix(meta,number);
    if(!valid(meta,number))return false;
    return '+'+code+number;
  }
  if(!/^\+[1-9]\d+$/.test(number))return false;
  let code='';for(let n=1;n<=3;n++)if(tables.calling_codes[number.slice(1,n+1)]){code=number.slice(1,n+1);break;}
  if(!code)return false;
  const regions=tables.calling_codes[code]!;
  const candidates=regions.map(r=>r==='001'?tables.non_geographic[code]!:tables.regions[r]!);
  const national=stripNationalPrefix(candidates[0]!,number.slice(code.length+1));
  return candidates.some(m=>(!m.leading||new RegExp(`^(?:${m.leading})`).test(national))&&valid(m,national))?`+${code}${national}`:false;
}

export async function internationalPhone(number:string|null|false):Promise<string|false> {
  if(!number) return false;
  if(!/^\+[1-9]\d+$/.test(number)) throw new NotPorted('phone formatting of noncanonical E164 input');
  data??=import('../../gen/out/phone.json',{with:{type:'json'}}).then(m=>m.default);
  const tables=await data;
  let code='';
  for(let length=1;length<=3;length++) if(tables.calling_codes[number.slice(1,1+length)]) {code=number.slice(1,1+length);break;}
  if(!code) return number;
  const national=number.slice(code.length+1),regions=tables.calling_codes[code]!;
  const metadata=(r:string):Metadata=>r==='001'?tables.non_geographic[code]!:tables.regions[r]!;
  const main=metadata(regions[0]!);
  // is_possible_number accepts possible and local-only lengths, but validity
  // still requires a full national-number type match (phone_parse.py).
  const region=regions.length===1?regions[0]:regions.find(r=>{const m=metadata(r);return m.leading?new RegExp(`^(?:${m.leading})`).test(national):valid(m,national);});
  if(!region||!valid(metadata(region),national)) return number;
  const format=main.formats.find(f=>(!f.leading||new RegExp(`^(?:${f.leading})`).test(national))&&full(f.pattern,national));
  const rendered=format?national.replace(new RegExp(`^(?:${format.pattern})$`),format.format.replace(/\\(\d+)/g,'$$$1')):national;
  return `+${code} ${rendered}`;
}

registerHooks('res.partner',{computed:{phone_formatted:async(env,ids)=>{
  const rows=(await env.cr.query<{id:number;phone_sanitized:string|null}>('SELECT id,phone_sanitized FROM res_partner WHERE id=ANY($1::int[])',[ids])).rows;
  const result=new Map<number,unknown>();for(const row of rows) result.set(row.id,await internationalPhone(row.phone_sanitized));return result;
}},search:{phone_mobile_search:searchPhone}});

/** phone_validation/models/mail_thread_phone.py _search_phone_mobile_search.
 * res.partner's phone field is its sole _phone_get_phone_mobile_search_fields. */
async function searchPhone(env:Environment,op:string,value:unknown):Promise<Domain>{
  if(op==='in')return or(await Promise.all((value as unknown[]).map(v=>searchPhone(env,'=',v))));
  if(op.startsWith('not ')||op==='!=')throw new NotPorted(`phone_mobile_search ${op}`);
  if(typeof value==='string')value=value.trim();
  if((value===true||!value)&&op==='=')return cond('phone',value?'!=':'=',false);
  if(!value)return TRUE;
  if(typeof value!=='string')throw new NotPorted('non-string phone search');
  if(value.length<3){if(env.lang&&env.lang!=='en_US')throw new NotPorted('translated short phone search');throw new UserError('Please enter at least 3 characters when searching a Phone number.');}
  const operator=op==='='?'=':['like','=like'].includes(op)?'LIKE':['ilike','=ilike'].includes(op)?'ILIKE':null;
  if(!operator)throw new NotPorted(`phone_mobile_search ${op}`);
  const pattern='[\\s\\\\./\\(\\)\\-]';
  const prefix=value.startsWith('+')?1:value.startsWith('00')?2:0;
  let term=value.slice(prefix).replace(/[\s\\./()\-]/g,'');
  if(op!=='=')term=prefix?`${term}%`:`%${term}%`;
  const values=prefix?['00'+term,'+'+term]:[term];
  const rows=await env.cr.query<{id:number}>(`SELECT id FROM res_partner WHERE ${values.map((_,i)=>`REGEXP_REPLACE(phone,$1,'','g') ${operator} $${i+2}`).join(' OR ')}`,[pattern,...values]);
  return cond('id','in',rows.rows.map(r=>r.id));
}
