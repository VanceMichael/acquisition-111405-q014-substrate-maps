import {createTransport} from './transport.mjs';

// 来源声明的裸片状态全集；空格、未测、明确失效互不归并，未声明值不得解释。
const STATES = new Set(['pass', 'fail', 'unmeasured', 'empty']);

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isInteger(value) {
  return Number.isInteger(value);
}

function isNumberPair(value) {
  return Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
}

function positionKey(mapId, x, y) {
  return JSON.stringify([mapId, x, y]);
}

function addTo(map, key, value) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// 校验并归一化一张图；结构不满足声明时整图不可解释，单元格级问题只剔除该格。
function parseMap(document, path, issues) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    issues.push({type: 'document', path, detail: '图文档不是对象'});
    return null;
  }
  const problems = [];
  if (!nonEmptyString(document.mapId)) problems.push('mapId缺失或不是非空字符串');
  if (!nonEmptyString(document.substrateId)) problems.push('substrateId缺失或不是非空字符串');
  if ('parent' in document && document.parent !== null && typeof document.parent !== 'string') {
    problems.push('parent必须是字符串或null');
  }
  if (!isNumberPair(document.origin)) problems.push('origin必须是二元数值数组');
  const axes = document.axes;
  if (!axes || typeof axes !== 'object' || Array.isArray(axes) || !isNumberPair(axes.x) || !isNumberPair(axes.y)) {
    problems.push('axes必须分别包含x、y二元数值向量');
  }
  if (!document.bins || typeof document.bins !== 'object' || Array.isArray(document.bins)) {
    problems.push('bins必须是对象');
  }
  if (!Array.isArray(document.cells)) problems.push('cells必须是数组');
  if (problems.length) {
    issues.push({type: 'document', path, mapId: nonEmptyString(document.mapId) ? document.mapId : null, detail: problems.join('；')});
    return null;
  }
  const bins = new Map();
  for (const [code, entry] of Object.entries(document.bins)) {
    const usable = entry && typeof entry === 'object' && !Array.isArray(entry)
      && STATES.has(entry.state) && (entry.label === undefined || typeof entry.label === 'string');
    if (!usable) {
      issues.push({type: 'bin', path, mapId: document.mapId, bin: code, detail: 'bin字典条目的state未声明或label非法，该代码不可用'});
      continue;
    }
    bins.set(code, {label: entry.label ?? null, state: entry.state});
  }
  const cells = [];
  const seen = new Set();
  for (const [index, cell] of document.cells.entries()) {
    const where = {path, mapId: document.mapId};
    if (!cell || typeof cell !== 'object' || Array.isArray(cell) || !isInteger(cell.x) || !isInteger(cell.y) || typeof cell.bin !== 'string') {
      issues.push({type: 'document', ...where, detail: `cells[${index}]缺少整数坐标或bin代码`});
      continue;
    }
    const local = [cell.x, cell.y];
    if (seen.has(positionKey('', cell.x, cell.y))) {
      issues.push({type: 'document', ...where, local, detail: '同一局部坐标在图中出现多次'});
      continue;
    }
    seen.add(positionKey('', cell.x, cell.y));
    let dieId = null;
    if ('dieId' in cell && cell.dieId !== null) {
      if (nonEmptyString(cell.dieId)) dieId = cell.dieId;
      else {
        issues.push({type: 'document', ...where, local, detail: 'dieId必须是非空字符串或null'});
        continue;
      }
    }
    cells.push({x: cell.x, y: cell.y, bin: cell.bin, dieId});
  }
  return {
    mapId: document.mapId, substrateId: document.substrateId, parent: document.parent ?? null,
    origin: [...document.origin], axes: {x: [...axes.x], y: [...axes.y]}, bins, cells, path
  };
}

// 校验转移清单；未声明的状态或缺字段的条目不得解释成业务事实，完全相同的重复陈述只算一次。
function parseTransfers(document, path, issues) {
  if (!Array.isArray(document)) {
    issues.push({type: 'document', path, detail: '转移清单不是数组'});
    return [];
  }
  const transfers = [];
  const seen = new Set();
  for (const [index, item] of document.entries()) {
    const endpoint = value => value && typeof value === 'object' && !Array.isArray(value)
      && nonEmptyString(value.mapId) && isInteger(value.x) && isInteger(value.y);
    if (!item || typeof item !== 'object' || Array.isArray(item) || !endpoint(item.from) || !endpoint(item.to) || !nonEmptyString(item.dieId)) {
      issues.push({type: 'transfer', path, detail: `transfers[${index}]缺少端点或dieId`});
      continue;
    }
    if (item.status !== 'confirmed' && item.status !== 'proposed') {
      issues.push({type: 'transfer', path, detail: `transfers[${index}]的status未声明：${JSON.stringify(item.status)}`});
      continue;
    }
    const transfer = {
      from: {mapId: item.from.mapId, x: item.from.x, y: item.from.y},
      to: {mapId: item.to.mapId, x: item.to.x, y: item.to.y},
      dieId: item.dieId, status: item.status
    };
    const key = JSON.stringify(transfer);
    if (seen.has(key)) continue;
    seen.add(key);
    transfers.push(transfer);
  }
  return transfers;
}

export async function collectSource({baseUrl, archive}) {
  const transport = createTransport(baseUrl);
  const issues = [];

  async function fetchJson(path) {
    let response;
    try {
      response = await transport.request(path);
    } catch (error) {
      issues.push({type: 'fetch', path, detail: `请求未完成：${error.message}`});
      return {ok: false, document: null};
    }
    if (!response.ok) {
      issues.push({type: 'fetch', path, status: response.status, detail: `来源返回状态${response.status}`});
      return {ok: false, document: null};
    }
    try {
      return {ok: true, document: response.json()};
    } catch {
      issues.push({type: 'document', path, detail: '响应不是有效JSON'});
      return {ok: false, document: null};
    }
  }

  // 只按索引声明的链接领取，遍历有界：索引一次、每张图一次、转移清单一次。
  const maps = new Map();
  let transfers = [];
  const index = await fetchJson('/substrates');
  if (index.ok) {
    const document = index.document;
    const mapLinks = [];
    let transfersLink = null;
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      issues.push({type: 'document', path: '/substrates', detail: '索引不是对象'});
    } else {
      if (!Array.isArray(document.maps)) {
        issues.push({type: 'document', path: '/substrates', detail: 'maps缺失或不是数组'});
      } else {
        for (const link of document.maps) {
          if (!nonEmptyString(link)) {
            issues.push({type: 'document', path: '/substrates', detail: 'maps含非字符串链接'});
            continue;
          }
          if (!mapLinks.includes(link)) mapLinks.push(link);
        }
      }
      if (!nonEmptyString(document.transfers)) {
        issues.push({type: 'document', path: '/substrates', detail: 'transfers链接缺失或不是字符串'});
      } else {
        transfersLink = document.transfers;
      }
    }
    for (const link of mapLinks) {
      const result = await fetchJson(link);
      if (!result.ok) continue;
      const map = parseMap(result.document, link, issues);
      if (!map) continue;
      if (maps.has(map.mapId)) {
        issues.push({type: 'document', path: link, mapId: map.mapId, detail: 'mapId在索引中重复，保留先领取的图'});
        continue;
      }
      maps.set(map.mapId, map);
    }
    if (transfersLink) {
      const result = await fetchJson(transfersLink);
      if (result.ok) transfers = parseTransfers(result.document, transfersLink, issues);
    }
  }

  const positions = new Map();
  for (const map of maps.values()) {
    for (const cell of map.cells) positions.set(positionKey(map.mapId, cell.x, cell.y), {map, cell});
  }

  // 只有confirmed且两个端点都确实存在的转移才能参与关联；proposed只登记不采纳。
  const claims = new Map();
  const outgoing = new Map();
  for (const transfer of transfers) {
    if (transfer.status !== 'confirmed') continue;
    const fromKey = positionKey(transfer.from.mapId, transfer.from.x, transfer.from.y);
    const toKey = positionKey(transfer.to.mapId, transfer.to.x, transfer.to.y);
    if (!positions.has(fromKey) || !positions.has(toKey)) {
      issues.push({type: 'transfer', detail: 'confirmed转移的端点不在已领取的图上，未关联', transfer});
      continue;
    }
    const claim = {dieId: transfer.dieId, kind: 'transfer', transfer};
    addTo(claims, fromKey, claim);
    addTo(claims, toKey, claim);
    addTo(outgoing, fromKey, transfer);
  }

  const records = [];
  for (const map of maps.values()) {
    for (const cell of map.cells) {
      const key = positionKey(map.mapId, cell.x, cell.y);
      const local = [cell.x, cell.y];
      // 轴方向与原点逐图解释：physical=origin+x*axisX+y*axisY，local原样保留。
      const physical = [
        map.origin[0] + cell.x * map.axes.x[0] + cell.y * map.axes.y[0],
        map.origin[1] + cell.x * map.axes.x[1] + cell.y * map.axes.y[1]
      ];
      const bin = map.bins.get(cell.bin);
      let state = null;
      if (!bin) {
        issues.push({type: 'bin', path: map.path, mapId: map.mapId, local, bin: cell.bin, detail: 'bin代码不在该图字典中，状态未决'});
      } else {
        state = bin.state;
      }
      const positionClaims = [...(cell.dieId ? [{dieId: cell.dieId, kind: 'cell'}] : []), ...(claims.get(key) ?? [])];
      const distinct = [...new Set(positionClaims.map(claim => claim.dieId))];
      let dieId = null;
      let identityStatus = 'unresolved';
      let candidates;
      if (state === 'empty') {
        // 空格只保留位置记录，任何身份依据都不产生已确认裸片身份。
        if (positionClaims.length) {
          issues.push({type: 'identity', path: map.path, mapId: map.mapId, local, detail: '空格位置带有裸片身份依据，未采纳'});
        }
      } else if (distinct.length === 1) {
        dieId = distinct[0];
        identityStatus = 'confirmed';
      } else if (distinct.length > 1) {
        // 多个互斥身份依据不能任选其一。
        identityStatus = 'conflict';
        candidates = positionClaims;
        issues.push({type: 'identity', path: map.path, mapId: map.mapId, local, detail: '多个互斥的裸片身份依据，身份未决', candidates: positionClaims});
      }
      records.push({
        id: `cell:${positionKey(map.mapId, cell.x, cell.y)}`,
        mapId: map.mapId, substrateId: map.substrateId, parent: map.parent,
        local, physical, bin: cell.bin, state,
        dieId, identityStatus, attribution: null,
        ...(candidates ? {candidates} : {})
      });
    }
  }

  const recordByKey = new Map(records.map(record => [positionKey(record.mapId, record.local[0], record.local[1]), record]));

  // 同一裸片不得有多个当前归属：按dieId归集没有转出记录的已确认位置，重复即冲突。
  const terminalsByDie = new Map();
  for (const record of records) {
    if (record.identityStatus !== 'confirmed') continue;
    const key = positionKey(record.mapId, record.local[0], record.local[1]);
    if ((outgoing.get(key) ?? []).length > 0) continue;
    addTo(terminalsByDie, record.dieId, record);
  }
  for (const [dieId, terminals] of terminalsByDie) {
    if (terminals.length < 2) continue;
    for (const record of terminals) {
      record.identityStatus = 'conflict';
      record.candidates = record.candidates ?? [{dieId, kind: 'cell'}];
      record.dieId = null;
    }
    issues.push({
      type: 'identity', dieId, detail: '同一裸片出现多个当前归属，相关位置身份均未决',
      positions: terminals.map(record => ({mapId: record.mapId, local: record.local}))
    });
  }

  // 当前归属：沿唯一的confirmed转出链走到终点；去向不唯一或成环则归属未决。
  function terminalFrom(startKey) {
    const seen = new Set();
    let current = startKey;
    while (true) {
      if (seen.has(current)) return null;
      seen.add(current);
      const destinations = [...new Set((outgoing.get(current) ?? []).map(transfer => positionKey(transfer.to.mapId, transfer.to.x, transfer.to.y)))];
      if (destinations.length === 0) return current;
      if (destinations.length > 1) return null;
      current = destinations[0];
    }
  }
  for (const record of records) {
    if (record.identityStatus !== 'confirmed') continue;
    const key = positionKey(record.mapId, record.local[0], record.local[1]);
    if (!(outgoing.get(key) ?? []).length) {
      record.attribution = {mapId: record.mapId, local: [...record.local]};
      continue;
    }
    const terminalKey = terminalFrom(key);
    const terminal = terminalKey ? recordByKey.get(terminalKey) : null;
    if (terminal && terminal.identityStatus === 'confirmed') {
      record.attribution = {mapId: terminal.mapId, local: [...terminal.local]};
    } else if (!terminalKey) {
      issues.push({type: 'identity', mapId: record.mapId, local: record.local, detail: '转移去向不唯一或成环，当前归属未决'});
    }
  }

  records.sort((a, b) => a.mapId.localeCompare(b.mapId) || a.local[0] - b.local[0] || a.local[1] - b.local[1]);
  const complete = issues.length === 0;
  await archive.commit({records, exchanges: transport.exchanges, issues});
  return {records, complete, issues, evidenceCount: transport.exchanges.length};
}
