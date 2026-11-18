import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSource} from '../src/source.mjs';
import {createClient} from '../src/transport.mjs';
import {collect,collectProfileTime,dailyUsage,reconcile} from '../src/reader.mjs';
import {Archive} from '../src/archive.mjs';
import {createApi} from '../src/api.mjs';

const directory = await mkdtemp(join(tmpdir(),'intake-'));
const source = await createSource({scenario:process.env.SCENARIO ?? 'normal'});
const archive = new Archive(directory);
const api = await createApi(archive);
try {
  console.log('本地来源',source.origin);
  const client = createClient(source.origin);
  const rows = await collect(client);
  console.log('实际收件',JSON.stringify(await archive.put(rows,{source:source.origin,adapter:'profile'})));
  const byTime = await collectProfileTime(client,{from:'2026-10-25T00:00:00Z',to:'2026-10-26T00:00:00Z'});
  console.log('时间筛选与按行补读对账',JSON.stringify(reconcile(byTime.rows,rows.filter(row => row.kind === 'load-profile-row'))));
  console.log('按表时钟汇总',JSON.stringify(dailyUsage(rows.filter(row => row.kind === 'load-profile-row')).map(({day,unit,total}) => ({day,unit,total}))));
  const response = await fetch(`${api.origin}/records`);
  console.log('查询原始结果',await response.text());
  console.log('来源交互',JSON.stringify(await client('/__audit')));
} finally {await Promise.all([source.close(),api.close()]);await rm(directory,{recursive:true,force:true});}
