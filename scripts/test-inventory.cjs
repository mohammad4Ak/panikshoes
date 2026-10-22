const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm')
const { transformSync } = require('esbuild')
const { memoryInventory } = require('./helpers/inventory-memory.cjs')
function load(file, dependencies = {}) {
  dependencies = { 'next/server': { NextResponse: Response }, ...dependencies }
  const cache = new Map()
  function read(relative) {
    const absolute = path.resolve(__dirname, '..', relative)
    if (cache.has(absolute)) return cache.get(absolute)
    const result = { exports: {} }
    vm.runInNewContext(transformSync(fs.readFileSync(absolute, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' }).code, {
      module: result, Date, URL, Response, Request, require(name) {
        if (name in dependencies) return dependencies[name]
        if (name.startsWith('@/lib/')) return read(`src/lib/${name.slice(6)}.ts`)
        if (name.startsWith('./')) return read(path.relative(path.resolve(__dirname, '..'), path.resolve(path.dirname(absolute), name + '.ts')))
        throw new Error('Unexpected dependency ' + name)
      },
    })
    cache.set(absolute, result.exports); return result.exports
  }
  return read(file)
}
const inventory = load('src/lib/inventory.ts'), contract = load('src/lib/inventory-contract.ts')
const rows = [{ size: 38, color: 'مشکی', stock: 1 }, { size: 38, color: 'کرم', stock: 8 }, { size: 39, color: 'مشکی', stock: 0 }, { size: 39, color: 'کرم', stock: 2 }]
const product = { id: 'shoe', name: 'پانیک', price: 100, stock: 11, sizes: [38, 39], colors: ['مشکی', 'کرم'], inventoryConfigured: true, inventoryVersion: 4 }
const variants = rows.map((row, i) => ({ id: 'v' + i, productId: product.id, ...row, isActive: true }))
const item = (extra = {}) => ({ productId: 'shoe', size: 38, color: 'مشکی', quantity: 1, ...extra })
const memory = extra => memoryInventory({ products: [product], variants, ...extra })
const totals = state => assert.equal(state.products[0].stock, state.variants.filter(v => v.isActive).reduce((sum, v) => sum + v.stock, 0))

test('Inventory matrix is complete, unique and integer bounded, including colorless zero-stock drafts', () => {
  assert.equal(inventory.parseInventoryRows(rows, [38,39], ['مشکی','کرم']).length, 4)
  assert.equal(inventory.parseInventoryRows([{ size:38,color:'-',stock:0 }], [38], []).length, 1)
  assert.equal(inventory.parseInventoryRows([], [], []).length, 0)
  for (const value of [rows.slice(1), [...rows, rows[0]], rows.map((r,i)=>i===0?{...r,stock:-1}:r), rows.map((r,i)=>i===0?{...r,size:40}:r), rows.map((r,i)=>i===0?{...r,stock:0.5}:r), rows.map(r=>({...r,stock:2147483647}))]) assert.throws(()=>inventory.parseInventoryRows(value,[38,39],['مشکی','کرم']))
  assert.throws(()=>inventory.parseInventoryRows([],Array.from({length:501},(_,i)=>i+1),[]))
})

test('Public inventory never publishes legacy totals as sellable units or retired variants', () => {
  const old = { ...product, inventoryConfigured:false, variants }
  assert.equal(contract.productInventory(old).stock, 0)
  assert.equal(contract.productInventory(old,true).legacyStock, 11)
  assert.equal('legacyStock' in contract.productInventory(old), false)
  assert.equal(contract.productInventory({...product,variants:[...variants,{...variants[0],id:'retired',isActive:false}]}).variants.length, 4)
})

test('A quote rejects a sold-out combination even when another color or size has stock', () => {
  const full = { ...product, variants }
  assert.throws(()=>inventory.assertInventoryAvailable(full,[item({size:39})]),error=>error.code==='STOCK_UNAVAILABLE'&&error.details.outOfStockDetails[0].size===39)
  assert.throws(()=>inventory.assertInventoryAvailable(full,[item(),item()]),error=>error.details.outOfStockDetails[0].availableQuantity===1)
  assert.throws(()=>inventory.assertInventoryAvailable({...full,inventoryConfigured:false},[item()]),error=>error.code==='INVENTORY_NOT_CONFIGURED')
})

test('Concurrent requests compete for the selected variant and cannot consume another color', async () => {
  const db=memory()
  const result=await Promise.allSettled([1,2].map(()=>db.prisma.$transaction(tx=>inventory.reserveInventory(tx,[item()]))))
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1)
  const state=db.state(); assert.equal(state.variants[0].stock,0);assert.equal(state.variants[1].stock,8);totals(state)
  assert.equal(state.products[0].inventoryVersion,5)
  assert.equal(state.stockMovements.length, 1)
  assert.equal(state.stockMovements[0].type, 'RESERVE')
  assert.equal(state.stockMovements[0].variantId, 'v0')
  assert.equal(state.stockMovements[0].stockBefore, 1)
  assert.equal(state.stockMovements[0].stockAfter, 0)
})

test('A product deleted after the catalog read returns an actionable stock conflict',async()=>{
  await assert.rejects(inventory.reserveInventory({product:{update:async()=>{throw {code:'P2025'}}}},[item()]),error=>error.code==='STOCK_UNAVAILABLE'&&error.status===409)
})

test('Duplicate cart lines aggregate per combination and failures roll back all variants and counters', async () => {
  const db=memory(), before=db.state()
  await assert.rejects(db.prisma.$transaction(tx=>inventory.reserveInventory(tx,[item({color:'کرم'}),item(),item()])),error=>error.code==='STOCK_UNAVAILABLE')
  assert.deepEqual(db.state(),before)
  const forced=new Error('rollback')
  await assert.rejects(db.prisma.$transaction(async tx=>{await inventory.reserveInventory(tx,[item()]);throw forced}),error=>error===forced)
  assert.deepEqual(db.state(),before)
})

test('Release restores exactly the historical variant and makes stale admin inventory versions fail', async () => {
  const db=memory()
  const ids=await db.prisma.$transaction(tx=>inventory.reserveInventory(tx,[item()]))
  assert.equal(ids.get(inventory.inventoryKey('shoe',38,'مشکی')),'v0')
  await db.prisma.$transaction(tx=>inventory.releaseInventory(tx,[item({variantId:'v0'})]))
  assert.equal(db.state().variants[0].stock,1);totals(db.state())
  await assert.rejects(db.prisma.$transaction(tx=>inventory.configureInventory(tx,'shoe',rows,4,{sizes:[38,39],colors:['مشکی','کرم']})),error=>error.code==='PRODUCT_INVENTORY_CHANGED')
  assert.equal(db.state().products[0].inventoryVersion,6)
  assert.deepEqual(db.state().stockMovements.map(row => [row.type, row.stockBefore, row.stockAfter]), [['RESERVE',1,0],['RELEASE',0,1]])
})

test('Payment and dispatch ledger events preserve stock, exact variants and immutable actor/order snapshots', async () => {
  const db = memory(), context = { actorId: 'admin', actorName: 'مدیر پانیک', orderId: 'historical-order', note: 'بررسی داخلی' }
  await db.prisma.$transaction(tx => inventory.recordOrderInventoryEvent(tx, [item({variantId:'v0'})], 'SALE', context))
  await db.prisma.$transaction(tx => inventory.recordOrderInventoryEvent(tx, [item({variantId:'v0'})], 'SHIPMENT', context))
  const state = db.state()
  assert.equal(state.products[0].stock, 11); assert.equal(state.variants[0].stock, 1)
  assert.deepEqual(state.stockMovements.map(row => [row.type,row.stockBefore,row.stockAfter,row.quantity,row.variantId,row.actorName,row.orderId]), [
    ['SALE',1,1,1,'v0','مدیر پانیک','historical-order'], ['SHIPMENT',1,1,1,'v0','مدیر پانیک','historical-order'],
  ])
  const before = db.state()
  await assert.rejects(db.prisma.$transaction(async tx => { await inventory.recordOrderInventoryEvent(tx,[item()], 'SALE', context); throw new Error('ledger rollback') }))
  assert.deepEqual(db.state(), before)
})

test('Absolute allocation records real adjustments and retired/reactivated units without a fake numeric loss', async () => {
  const db = memory()
  await db.prisma.$transaction(tx => inventory.configureInventory(tx,'shoe',[{size:38,color:'مشکی',stock:2}],4,{sizes:[38],colors:['مشکی']},{actorId:'admin',actorName:'مدیر'}))
  let state = db.state()
  assert.equal(state.products[0].stock,2)
  const retired = state.stockMovements.filter(row => row.type === 'VARIANT_STATUS')
  assert.equal(retired.length,3)
  assert.ok(retired.every(row => row.activeBefore && !row.activeAfter && row.stockBefore === row.stockAfter))
  assert.ok(retired.some(row => row.quantity===8))
  assert.deepEqual(state.stockMovements.filter(row => row.type==='ADJUSTMENT').map(row=>[row.variantId,row.stockBefore,row.stockAfter,row.quantity]),[['v0',1,2,1]])
  await db.prisma.$transaction(tx => inventory.configureInventory(tx,'shoe',[{size:38,color:'کرم',stock:8}],5,{sizes:[38],colors:['کرم']}))
  state = db.state()
  assert.equal(state.products[0].stock,8)
  const activated = state.stockMovements.filter(row=>row.type==='VARIANT_STATUS'&&!row.activeBefore&&row.activeAfter)
  assert.equal(activated.length,1); assert.equal(activated[0].variantId,'v1'); assert.equal(activated[0].stockBefore,8); assert.equal(activated[0].stockAfter,8)
})

test('Manual conversion preserves old totals until explicit allocation and links historical/retired combinations', async () => {
  const db=memory({products:[{...product,inventoryConfigured:false,inventoryVersion:0,stock:7}],variants:[],items:[{id:'old',productId:'shoe',size:40,color:'قدیمی',variantId:null}]})
  assert.equal(db.state().products[0].stock,7)
  await db.prisma.$transaction(tx=>inventory.configureInventory(tx,'shoe',rows,0,{sizes:[38,39],colors:['مشکی','کرم']}))
  const converted=db.state(), retired=converted.variants.find(v=>v.color==='قدیمی')
  assert.equal(retired.stock,0); assert.equal(retired.isActive,false);assert.equal(converted.items[0].variantId,retired.id)
  await db.prisma.$transaction(tx=>inventory.releaseInventory(tx,[item({size:40,color:'قدیمی',variantId:retired.id,quantity:2})]))
  assert.equal(db.state().variants.find(v=>v.id===retired.id).stock,2)
  assert.equal(db.state().products[0].stock,11);totals(db.state())
  await assert.rejects(db.prisma.$transaction(tx=>inventory.reserveInventory(tx,[item({size:40,color:'قدیمی',variantId:retired.id})],{allowLegacy:true})),error=>error.code==='STOCK_UNAVAILABLE')
})

test('Legacy allocation closes its original unassigned ledger balance before opening explicit variants', async () => {
  const db=memory({products:[{...product,inventoryConfigured:false,inventoryVersion:0,stock:7}],variants:[],stockMovements:[{
    id:'opening-legacy:shoe',productId:'shoe',variantId:null,type:'OPENING',quantity:7,stockBefore:0,stockAfter:7,activeBefore:false,activeAfter:false,
  }]})
  await db.prisma.$transaction(tx=>inventory.configureInventory(tx,'shoe',rows,0,{sizes:[38,39],colors:['مشکی','کرم']},{actorId:'admin',actorName:'مدیر',note:'تخصیص دستی'}))
  const state=db.state(), legacy=state.stockMovements.filter(row=>row.variantId===null)
  assert.equal(legacy.length,2)
  assert.equal(legacy[1].type,'ADJUSTMENT');assert.equal(legacy[1].stockBefore,7);assert.equal(legacy[1].stockAfter,0)
  assert.equal(legacy[1].activeBefore,false);assert.equal(legacy[1].activeAfter,false)
  assert.equal(legacy[1].actorId,'admin');assert.match(legacy[1].note,/تخصیص ماندهٔ قدیمی/)
  assert.equal(legacy.reduce((sum,row)=>sum+row.stockAfter-row.stockBefore,0),0)
  assert.equal(state.stockMovements.reduce((sum,row)=>sum+row.stockAfter-row.stockBefore,0),state.products[0].stock)
  assert.equal(state.products[0].stock,11);assert.equal(state.products[0].inventoryVersion,1)
  const eventCount=state.stockMovements.length
  await db.prisma.$transaction(tx=>inventory.configureInventory(tx,'shoe',rows,1,{sizes:[38,39],colors:['مشکی','کرم']}))
  assert.equal(db.state().stockMovements.length,eventCount,'A subsequent unchanged allocation must not close or open balances again')
})

test('Unconfigured inventory can service historical orders but never accepts a new purchase', async () => {
  const db=memory({products:[{...product,inventoryConfigured:false}],variants:[]})
  await assert.rejects(db.prisma.$transaction(tx=>inventory.reserveInventory(tx,[item()])),error=>error.code==='INVENTORY_NOT_CONFIGURED')
  await db.prisma.$transaction(tx=>inventory.reserveInventory(tx,[item()],{allowLegacy:true}))
  assert.equal(db.state().products[0].stock,10)
  await db.prisma.$transaction(tx=>inventory.releaseInventory(tx,[item()]))
  assert.equal(db.state().products[0].stock,11)
})

test('Cross-product variant references and overflow cannot corrupt returned stock', async () => {
  const db=memory(), before=db.state()
  await assert.rejects(db.prisma.$transaction(tx=>inventory.releaseInventory(tx,[item({variantId:'other'})])),error=>error.code==='INVENTORY_CONFLICT')
  assert.deepEqual(db.state(),before)
  const full=memory({products:[{...product,stock:2147483647}],variants:[{...variants[0],stock:2147483647}]})
  await assert.rejects(full.prisma.$transaction(tx=>inventory.releaseInventory(tx,[item()])),error=>error.code==='INVENTORY_CONFLICT')
  assert.equal(full.state().products[0].stock,2147483647)
})

function catalogApi(db, session = { user:{id:'admin',role:'ADMIN'} }) {
  const prisma=new Proxy(db.prisma,{get:(target,key)=>key==='category'?{findUnique:async()=>({id:'cat'})}:target[key]})
  const dependencies={ '@/lib/prisma':{prisma}, '@/lib/auth':{auth:async()=>session}, '@/lib/product-reviews':{withProductRatings:async products=>products}, '@/lib/payments':{expireUnpaidOrders:async()=>0} }
  return { create:load('src/app/api/products/route.ts',dependencies), update:load('src/app/api/products/[id]/route.ts',dependencies) }
}
const request=body=>new Request('http://localhost/api/products',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
const context={params:Promise.resolve({id:'shoe'})}

test('Product creation derives total stock only from the complete variant matrix', async()=>{
  const db=memoryInventory({}),api=catalogApi(db)
  const response=await api.create.POST(request({code:'TEST-100',name:'پانیک',price:100,categoryId:'cat',sizes:[38,39],colors:['مشکی','کرم'],variants:rows}))
  assert.equal(response.status,201)
  const result=await response.json();assert.equal(result.stock,11);assert.equal(result.inventoryConfigured,true);assert.equal(result.variants.length,4)
  for(const invalid of [{stock:99},{variants:rows.slice(1)},{variants:[...rows.slice(1),rows[1]]}]) {
    assert.equal((await api.create.POST(request({code:'TEST-100',name:'پانیک',price:100,categoryId:'cat',sizes:[38,39],colors:['مشکی','کرم'],variants:rows,...invalid}))).status,400)
  }
  assert.equal(db.state().products.length,1)
  assert.equal(db.state().stockMovements.filter(row=>row.type==='OPENING').length,4)
  assert.ok(db.state().stockMovements.every(row=>row.actorId==='admin'&&row.productName==='پانیک'))
})

test('Products with inventory history cannot be deleted even when no order items remain', async()=>{
  const db = memory({stockMovements:[{id:'historic',productId:'shoe',type:'OPENING'}]}), api=catalogApi(db)
  const result = await api.update.DELETE(request({}),context)
  assert.equal(result.status,409); assert.match((await result.json()).error,/گردش موجودی/)
  assert.equal(db.state().products.length,1)
})

test('Admin inventory changes require current version and roll back metadata on stale forms',async()=>{
  const db=memory(),api=catalogApi(db),changed=rows.map(row=>({...row,stock:0}))
  const stale=await api.update.PUT(request({name:'stale',variants:changed,expectedInventoryVersion:3}),context)
  assert.equal(stale.status,409);assert.equal((await stale.json()).code,'PRODUCT_INVENTORY_CHANGED');assert.equal(db.state().products[0].name,'پانیک')
  const saved=await api.update.PUT(request({name:'fresh',variants:changed,expectedInventoryVersion:4}),context)
  assert.equal(saved.status,200);assert.equal((await saved.json()).stock,0);assert.equal(db.state().products[0].inventoryVersion,5)
  assert.equal((await api.update.PUT(request({description:'only metadata'}),context)).status,200)
  assert.equal(db.state().products[0].stock,0);assert.equal(db.state().products[0].inventoryVersion,5)
})

test('Dimension edits and aggregate inventory writes cannot bypass matrix validation',async()=>{
  const db=memory(),api=catalogApi(db),before=db.state()
  for(const invalid of [{stock:99,expectedStock:11},{sizes:[40]},{colors:['سفید']},{variants:rows},{variants:rows,expectedInventoryVersion:null}]) {
    assert.equal((await api.update.PUT(request(invalid),context)).status,400)
    assert.deepEqual(db.state(),before)
  }
})

test('Public and admin catalog responses distinguish unallocated stock and variant availability',async()=>{
  const db=memory({products:[{...product,inventoryConfigured:false}],variants:[]})
  const anon=catalogApi(db,null),admin=catalogApi(db)
  const publicResponse=await anon.create.GET(new Request('http://localhost/api/products'))
  const exposed=await publicResponse.json();assert.equal(exposed[0].stock,0);assert.equal('legacyStock' in exposed[0],false)
  assert.equal(publicResponse.headers.get('cache-control'),'private, no-store')
  const owned=await (await admin.update.GET(new Request('http://localhost/api/products/shoe'),context)).json()
  assert.equal(owned.stock,0);assert.equal(owned.legacyStock,11)
})

test('Regular customers cannot create or allocate product inventory',async()=>{
  const db=memory(),api=catalogApi(db,{user:{id:'buyer',role:'USER'}}),before=db.state()
  assert.equal((await api.update.PUT(request({variants:rows,expectedInventoryVersion:4}),context)).status,401)
  assert.equal((await api.create.POST(request({code:'TEST-100',name:'shoe',price:100,categoryId:'cat',variants:[]}))).status,401)
  assert.deepEqual(db.state(),before)
})
