import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PostEventV1 } from '../../contracts/v1/index';
/** Owned loopback receiver only. No production config or credentials are read. */
export async function consumerFixture(failFirst = false) {
 const dir=await mkdtemp(join(tmpdir(),'post-consumer-'));
 const db=new Database(join(dir,'inbox.sqlite'));
 db.run('CREATE TABLE inbox(id TEXT PRIMARY KEY, body TEXT NOT NULL)');
 const attempts:string[]=[];
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
  if(req.headers.get('authorization')!=='Bearer test-receiver')return new Response(null,{status:401});
  const body=await req.text(); attempts.push(body);
  if(failFirst && attempts.length===1)return new Response(null,{status:503});
  let event;try {event=PostEventV1.parse(JSON.parse(body));}catch{return new Response(null,{status:400});}
  db.query('INSERT OR IGNORE INTO inbox VALUES (?,?)').run(event.delivery_id,body);
  return new Response(null,{status:204});
 }});
 return {url:`http://127.0.0.1:${server.port}`,attempts,db,dir,async close(){await server.stop(true);db.close();await rm(dir,{recursive:true});}};
}
