import {resolve} from 'node:path';
import {createSource} from './source.mjs';
import {createClient} from './transport.mjs';
import {collectProfile,registerValue} from './reader.mjs';
import {Archive} from './archive.mjs';
import {createApi} from './api.mjs';
import {readCursor,writeCursor} from './cursor.mjs';

const directory = resolve(process.env.DATA_DIR ?? '.state');
const source = await createSource({port:Number(process.env.SOURCE_PORT ?? 4010),scenario:process.env.SCENARIO ?? 'normal'});
const archive = new Archive(directory);
const api = await createApi(archive,Number(process.env.PORT ?? 4020));
console.log(JSON.stringify({source:source.origin,api:api.origin}));
try {
  const client = createClient(source.origin);
  const register = registerValue(await client('/register'));
  console.log(JSON.stringify(await archive.put([register],{source:source.origin,adapter:'current'})));
  let cursor = await readCursor(directory);
  for (;;) {
    const profile = await collectProfile(client,{cursor,pageLimit:50});
    if (profile.rows.length) console.log(JSON.stringify(await archive.put(profile.rows,{source:source.origin,adapter:'current'})));
    cursor = {meterEpoch:profile.meterEpoch,nextEntry:profile.nextEntry};
    await writeCursor(directory,cursor);
    if (profile.uninterpretable.length) console.log('不可解释区间',JSON.stringify(profile.uninterpretable));
    if (profile.complete) break;
  }
} catch(error) {console.error(error.message);}
let stopping = false;
const stop = async () => {if(stopping) return;stopping = true;await Promise.all([source.close(),api.close()]);};
process.on('SIGINT',stop);process.on('SIGTERM',stop);
