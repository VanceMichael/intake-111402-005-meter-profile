import {SourceError} from './transport.mjs';

export function registerValue(register) {
  if (!Number.isInteger(register.scaler) || !Number.isFinite(register.value)) throw new Error('invalid register');
  return {id:register.logicalName,raw:register.value,value:register.value * 10 ** register.scaler,unit:register.unit};
}

// 来源投影的时间口径：表面时间按 UTC 解析后加 deviation 分钟，与 /profiles/load/time 的筛选口径一致。
export function clockInstant(clock) {
  return new Date(Date.parse(`${clock.local}Z`) + clock.deviation * 60000).toISOString();
}

class CaptureDefinitionError extends Error {}

function parseColumns(data,version) {
  if (!Array.isArray(data?.columns) || data.columns.length === 0) throw new CaptureDefinitionError(`capture ${version} without columns`);
  return data.columns.map(column => {
    if (typeof column?.logicalName !== 'string' || !Number.isInteger(column?.attribute) ||
        !Number.isInteger(column?.scaler) || typeof column?.unit !== 'string') throw new CaptureDefinitionError(`capture ${version} column invalid`);
    return {logicalName:column.logicalName,attribute:column.attribute,scaler:column.scaler,unit:column.unit};
  });
}

// 曲线行的标识用 meterEpoch + entry，不用表面时间：夏令时回拨会让两个不同 entry 拥有相同的 clock.local。
function profileRow(raw,meterEpoch) {
  if (!Number.isInteger(raw?.entry) || typeof raw?.captureVersion !== 'string' || raw.captureVersion === '') throw new Error('invalid profile row');
  const clock = raw.clock;
  if (typeof clock?.local !== 'string' || !Number.isFinite(Date.parse(`${clock.local}Z`)) ||
      !Number.isInteger(clock.deviation) || !Number.isInteger(clock.status)) throw new Error('invalid profile row');
  if (!Array.isArray(raw.values) || raw.values.some(value => !Number.isFinite(value))) throw new Error('invalid profile row');
  return {
    id:`load-profile/${encodeURIComponent(meterEpoch)}/entry/${raw.entry}`,
    kind:'load-profile-entry',
    meterEpoch,
    entry:raw.entry,
    captureVersion:raw.captureVersion,
    clock:{local:clock.local,deviation:clock.deviation,status:clock.status},
    instant:clockInstant(clock),
    raw:[...raw.values],
  };
}

// 每段曲线只按自己的 captureVersion 对应的定义解释；定义被来源拒绝或失效时标记不可解释，不拿当前版本定义补空。
function interpret(row,definition) {
  if (definition.refused) return {...row,interpretable:false,cause:{reason:'capture-refused',captureVersion:row.captureVersion,status:definition.refused.status,detail:definition.refused.detail}};
  if (definition.invalid) return {...row,interpretable:false,cause:{reason:'capture-invalid',captureVersion:row.captureVersion,detail:definition.invalid}};
  if (definition.columns.length !== row.raw.length) return {...row,interpretable:false,cause:{reason:'capture-column-mismatch',captureVersion:row.captureVersion,columns:definition.columns.length,values:row.raw.length}};
  return {
    ...row,
    interpretable:true,
    capture:{version:row.captureVersion,columns:definition.columns},
    values:definition.columns.map((column,index) => ({
      logicalName:column.logicalName,
      attribute:column.attribute,
      raw:row.raw[index],
      scaler:column.scaler,
      value:row.raw[index] * 10 ** column.scaler,
      unit:column.unit,
    })),
  };
}

async function captureDefinition(client,cache,version) {
  if (!cache.has(version)) {
    let definition;
    try {
      definition = {columns:parseColumns(await client(`/captures/${encodeURIComponent(version)}`),version)};
    } catch (error) {
      if (error instanceof SourceError) definition = {refused:{status:error.status,detail:error.data}};
      else if (error instanceof CaptureDefinitionError) definition = {invalid:error.message};
      else throw error;
    }
    cache.set(version,definition);
  }
  return cache.get(version);
}

async function interpretRows(client,cache,rows,meterEpoch) {
  const interpreted = [];
  for (const raw of rows) {
    const row = profileRow(raw,meterEpoch);
    interpreted.push(interpret(row,await captureDefinition(client,cache,row.captureVersion)));
  }
  return interpreted;
}

// 把相邻的不可解释行归并为区间，便于对账时标出哪一段曲线缺少解释依据。
export function uninterpretableIntervals(rows) {
  const intervals = [];
  let previous;
  for (const row of rows) {
    if (!row.interpretable) {
      if (previous && !previous.interpretable) {
        const last = intervals[intervals.length - 1];
        last.toEntry = row.entry;
        last.count += 1;
        if (!last.captureVersions.includes(row.captureVersion)) last.captureVersions.push(row.captureVersion);
        if (!last.reasons.includes(row.cause.reason)) last.reasons.push(row.cause.reason);
      } else {
        intervals.push({fromEntry:row.entry,toEntry:row.entry,count:1,captureVersions:[row.captureVersion],reasons:[row.cause.reason]});
      }
    }
    previous = row;
  }
  return intervals;
}

function profileHeader(header) {
  if (typeof header?.meterEpoch !== 'string' || header.meterEpoch === '') throw new Error('invalid profile header');
  return header;
}

// 按行补读负荷曲线。options.fromEntry 指定起点（默认 1）；options.cursor 为上次续读游标，优先于 fromEntry。
// 游标 nextEntry 为 null 表示上次已读完；meterEpoch 变化说明表已更换，丢弃旧游标从头重读。
// options.pageLimit 限制本次领取的页数：抄表员可分段领取并逐段落盘游标，中断后从 nextEntry 续接，不用重新抄整张表。
export async function collectProfile(client,options = {}) {
  const header = profileHeader(await client('/profiles/load'));
  let fromEntry = options.fromEntry ?? 1;
  if (options.cursor) {
    if (options.cursor.meterEpoch !== header.meterEpoch) fromEntry = 1;
    else if (options.cursor.nextEntry === null) return {rows:[],nextEntry:null,complete:true,meterEpoch:header.meterEpoch,header,uninterpretable:[]};
    else fromEntry = options.cursor.nextEntry;
  }
  if (options.pageLimit !== undefined && (!Number.isInteger(options.pageLimit) || options.pageLimit < 1)) throw new Error('invalid page limit');
  const pageLimit = options.pageLimit ?? Number.POSITIVE_INFINITY;
  const cache = new Map();
  const rows = [];
  const seen = new Set();
  const maxPages = options.maxPages ?? 1000;
  for (let page = 0; page < maxPages; page += 1) {
    if (seen.has(fromEntry)) throw new Error(`source pagination loop at entry ${fromEntry}`);
    seen.add(fromEntry);
    const data = await client(`/profiles/load/entries?fromEntry=${fromEntry}`);
    if (data?.meterEpoch !== header.meterEpoch) throw new Error('meter epoch changed during profile read');
    if (!Array.isArray(data.rows) || (data.nextEntry !== null && !Number.isInteger(data.nextEntry))) throw new Error('invalid profile page');
    rows.push(...await interpretRows(client,cache,data.rows,data.meterEpoch));
    if (data.nextEntry === null) return {rows,nextEntry:null,complete:true,meterEpoch:header.meterEpoch,header,uninterpretable:uninterpretableIntervals(rows)};
    fromEntry = data.nextEntry;
    if (page + 1 >= pageLimit) return {rows,nextEntry:fromEntry,complete:false,meterEpoch:header.meterEpoch,header,uninterpretable:uninterpretableIntervals(rows)};
  }
  throw new Error('profile pagination limit exceeded');
}

// 按带偏差的 ISO 时间半开区间筛选同一档案。
export async function collectProfileByTime(client,options = {}) {
  const from = Date.parse(options.from), to = Date.parse(options.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error('time range required');
  const header = profileHeader(await client('/profiles/load'));
  const data = await client(`/profiles/load/time?from=${encodeURIComponent(options.from)}&to=${encodeURIComponent(options.to)}`);
  if (data?.meterEpoch !== header.meterEpoch || !Array.isArray(data.rows)) throw new Error('invalid profile time response');
  const rows = await interpretRows(client,new Map(),data.rows,data.meterEpoch);
  return {rows,meterEpoch:data.meterEpoch,complete:data.complete === true,header,uninterpretable:uninterpretableIntervals(rows)};
}

// 对账：按行补读与按时间筛选两条路径的结果按 entry 对齐比较。
// 交集内内容必须完全一致；只出现在一侧的行属于覆盖差异，单独列出不算内容冲突。
export function reconcileProfile(entryRows,timeRows) {
  const report = {consistent:true,matched:[],mismatches:[],onlyInEntries:[],onlyInTime:[],duplicateEntries:[],duplicateTime:[]};
  const index = (rows,duplicates) => {
    const map = new Map();
    for (const row of rows) {
      if (map.has(row.id)) {duplicates.push(row.id);report.consistent = false;continue;}
      map.set(row.id,row);
    }
    return map;
  };
  const entries = index(entryRows,report.duplicateEntries);
  const timed = index(timeRows,report.duplicateTime);
  for (const [id,row] of entries) {
    const other = timed.get(id);
    if (!other) {report.onlyInEntries.push(id);continue;}
    if (JSON.stringify(row) === JSON.stringify(other)) report.matched.push(id);
    else {report.mismatches.push({id,entryRow:row,timeRow:other});report.consistent = false;}
  }
  for (const id of timed.keys()) if (!entries.has(id)) report.onlyInTime.push(id);
  return report;
}

export async function collect(client,options = {}) {
  const register = registerValue(await client('/register'));
  const profile = await collectProfile(client,options.profile ?? {});
  return [register,...profile.rows];
}
