import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {collect} from '../src/collector.mjs';
import {openArchive} from '../src/archive.mjs';

// 与设计相符的边界验证：自带最小来源，不复用、不修改验收夹具。
async function startStub(routes) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({method: request.method, path: request.url});
    const route = routes[request.url];
    if (!route) { response.writeHead(404).end('未声明的资料接口'); return; }
    response.writeHead(route.status ?? 200, {'content-type': 'application/json'}).end(JSON.stringify(route.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise(resolve => server.close(resolve))
  };
}

function map(overrides) {
  return {
    mapId: 'm0', substrateId: 'w0', parent: null,
    origin: [0, 0], axes: {x: [1, 0], y: [0, 1]},
    bins: {1: {label: 'good', state: 'pass'}},
    cells: [{x: 0, y: 0, bin: '1'}],
    ...overrides
  };
}

async function run(routes, {runs = 1} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'boundary-'));
  const source = await startStub(routes);
  try {
    let result;
    for (let iteration = 0; iteration < runs; iteration++) {
      result = await collect({baseUrl: source.baseUrl, archive: await openArchive(directory), mode: 'source'});
    }
    return {result, source, snapshot: (await openArchive(directory)).snapshot()};
  } finally {
    await source.close();
    await rm(directory, {recursive: true, force: true});
  }
}

const index = (maps, transfers = '/transfers') => ({'/substrates': {body: {maps, transfers}}});

test('confirmed转移连接两个端点：各自保留局部格点，按各自图解释physical，归属指向终点', async () => {
  const wafer = map({mapId: 'wafer', cells: [{x: 3, y: 4, bin: '1'}]});
  const carrier = map({
    mapId: 'carrier', substrateId: 'c0', parent: 'w0',
    origin: [100, 50], axes: {x: [0, -1], y: [1, 0]},
    cells: [{x: 1, y: 1, bin: '1'}]
  });
  const routes = {
    ...index(['/wafer', '/carrier']),
    '/wafer': {body: wafer},
    '/carrier': {body: carrier},
    '/transfers': {body: [{from: {mapId: 'wafer', x: 3, y: 4}, to: {mapId: 'carrier', x: 1, y: 1}, dieId: 'd1', status: 'confirmed'}]}
  };
  const {result} = await run(routes);
  assert.equal(result.complete, true);
  const from = result.records.find(record => record.mapId === 'wafer');
  const to = result.records.find(record => record.mapId === 'carrier');
  assert.deepEqual(from.local, [3, 4]);
  assert.deepEqual(from.physical, [3, 4]);
  assert.deepEqual(to.local, [1, 1]);
  assert.deepEqual(to.physical, [101, 49]);
  assert.equal(from.dieId, 'd1');
  assert.equal(to.dieId, 'd1');
  assert.equal(from.identityStatus, 'confirmed');
  assert.deepEqual(from.attribution, {mapId: 'carrier', local: [1, 1]});
  assert.deepEqual(to.attribution, {mapId: 'carrier', local: [1, 1]});
});

test('跨载具同坐标同bin但无转移依据：只记未关联，不猜同一裸片', async () => {
  const second = map({mapId: 'm1', substrateId: 'w1'});
  const routes = {
    ...index(['/m0', '/m1']),
    '/m0': {body: map({})},
    '/m1': {body: second},
    '/transfers': {body: []}
  };
  const {result} = await run(routes);
  assert.equal(result.complete, true);
  assert.equal(result.records.length, 2);
  for (const record of result.records) {
    assert.equal(record.identityStatus, 'unresolved');
    assert.equal(record.dieId, null);
    assert.equal(record.attribution, null);
  }
});

test('confirmed转移端点缺失：只记未关联并留下缺口，不声明完整', async () => {
  const routes = {
    ...index(['/m0']),
    '/m0': {body: map({})},
    '/transfers': {body: [{from: {mapId: 'm0', x: 0, y: 0}, to: {mapId: 'ghost', x: 0, y: 0}, dieId: 'd1', status: 'confirmed'}]}
  };
  const {result} = await run(routes);
  assert.equal(result.complete, false);
  assert.ok(result.issues.some(issue => issue.type === 'transfer'));
  assert.equal(result.records[0].identityStatus, 'unresolved');
  assert.equal(result.records[0].dieId, null);
});

test('空格、未测、明确失效是不同状态，bin文本不归并', async () => {
  const document = map({
    bins: {
      0: {label: 'not measured', state: 'unmeasured'},
      1: {label: 'good', state: 'pass'},
      2: {label: 'inkless fail', state: 'fail'},
      3: {label: 'no die', state: 'empty'}
    },
    cells: [
      {x: 0, y: 0, bin: '0'},
      {x: 1, y: 0, bin: '1'},
      {x: 2, y: 0, bin: '2'},
      {x: 3, y: 0, bin: '3'}
    ]
  });
  const routes = {...index(['/m0']), '/m0': {body: document}, '/transfers': {body: []}};
  const {result} = await run(routes);
  assert.equal(result.complete, true);
  assert.deepEqual(result.records.map(record => record.state), ['unmeasured', 'pass', 'fail', 'empty']);
  assert.ok(result.records.every(record => record.identityStatus === 'unresolved'));
});

test('空格携带dieId不产生已确认身份', async () => {
  const document = map({
    bins: {3: {label: 'no die', state: 'empty'}},
    cells: [{x: 0, y: 0, bin: '3', dieId: 'd9'}]
  });
  const routes = {...index(['/m0']), '/m0': {body: document}, '/transfers': {body: []}};
  const {result} = await run(routes);
  assert.equal(result.complete, false);
  assert.equal(result.records[0].state, 'empty');
  assert.equal(result.records[0].identityStatus, 'unresolved');
  assert.equal(result.records[0].dieId, null);
  assert.ok(result.issues.some(issue => issue.type === 'identity'));
});

test('bin代码不在字典中或state未声明：状态未决且留缺口，不按文本猜', async () => {
  const document = map({
    bins: {7: {label: 'dead on arrival', state: 'dead'}},
    cells: [{x: 0, y: 0, bin: '7'}, {x: 1, y: 0, bin: '9'}]
  });
  const routes = {...index(['/m0']), '/m0': {body: document}, '/transfers': {body: []}};
  const {result} = await run(routes);
  assert.equal(result.complete, false);
  assert.deepEqual(result.records.map(record => record.state), [null, null]);
  assert.ok(result.issues.filter(issue => issue.type === 'bin').length >= 2);
});

test('同一dieId出现两个当前归属：两处都冲突，不得各自确认', async () => {
  const wafer = map({cells: [{x: 0, y: 0, bin: '1'}, {x: 1, y: 0, bin: '1'}]});
  const carrierA = map({mapId: 'ca', substrateId: 'ca0'});
  const carrierB = map({mapId: 'cb', substrateId: 'cb0'});
  const routes = {
    ...index(['/m0', '/ca', '/cb']),
    '/m0': {body: wafer},
    '/ca': {body: carrierA},
    '/cb': {body: carrierB},
    '/transfers': {body: [
      {from: {mapId: 'm0', x: 0, y: 0}, to: {mapId: 'ca', x: 0, y: 0}, dieId: 'd1', status: 'confirmed'},
      {from: {mapId: 'm0', x: 1, y: 0}, to: {mapId: 'cb', x: 0, y: 0}, dieId: 'd1', status: 'confirmed'}
    ]}
  };
  const {result} = await run(routes);
  assert.equal(result.complete, false);
  const terminals = result.records.filter(record => record.mapId !== 'm0');
  assert.ok(terminals.every(record => record.identityStatus === 'conflict' && record.dieId === null));
  assert.ok(result.issues.some(issue => issue.type === 'identity' && issue.dieId === 'd1'));
});

test('索引不可用时无记录、留缺口，错误响应仍归档为原文证据', async () => {
  const routes = {'/substrates': {status: 500, body: {error: '来源故障'}}};
  const {result, snapshot} = await run(routes);
  assert.deepEqual(result.records, []);
  assert.equal(result.complete, false);
  assert.ok(result.issues.length > 0);
  assert.equal(result.evidenceCount, 1);
  assert.equal(snapshot.evidence.length, 1);
});

test('记录标识稳定：重复领取不产生新修订', async () => {
  const routes = {
    ...index(['/m0']),
    '/m0': {body: map({})},
    '/transfers': {body: []}
  };
  const {result, snapshot} = await run(routes, {runs: 2});
  assert.equal(result.complete, true);
  assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].id, result.records[0].id);
});
