// Local-only integration test. Exact randomized fixtures are removed in finally.
const assert=require('node:assert/strict')
const {randomBytes}=require('node:crypto')
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm')
const {transformSync}=require('esbuild')
const {PrismaClient}=require('@prisma/client')
const target=new URL(process.env.DATABASE_URL||'postgresql://invalid/invalid')
if(target.hostname!=='192.168.1.104'||target.pathname!=='/shoes_shop') throw new Error('Inventory integration test requires the local development shoes_shop database')
const cache=new Map()
function load(relative){
  if(cache.has(relative))return cache.get(relative)
  const result={exports:{}}
  vm.runInNewContext(transformSync(fs.readFileSync(path.join(__dirname,'..',relative),'utf8'),{loader:'ts',format:'cjs',target:'es2022'}).code,{module:result,Date,require(name){
    if(name==='next/server')return {NextResponse:Response}
    if(name.startsWith('./'))return load(path.posix.join(path.posix.dirname(relative),name+'.ts'))
    throw new Error('Unexpected dependency '+name)
  }})
  cache.set(relative,result.exports);return result.exports
}
const {configureInventory,reserveInventory,releaseInventory,inventoryKey}=load('src/lib/inventory.ts')
const prisma=new PrismaClient(),prefix='TEST_VARIANT_'+randomBytes(6).toString('hex')
const productIds=[prefix+'_SHOE',prefix+'_LEGACY'],orderIds=[prefix+'_ORDER']
const userId=prefix+'_USER',categoryId=prefix+'_CATEGORY'
const rows=[{size:38,color:'مشکی',stock:1},{size:38,color:'کرم',stock:8},{size:39,color:'مشکی',stock:0},{size:39,color:'کرم',stock:2}]
const dims={sizes:[38,39],colors:['مشکی','کرم']}
const item=(extra={})=>({productId:productIds[0],size:38,color:'مشکی',quantity:1,...extra})
const tx=callback=>prisma.$transaction(callback,{isolationLevel:'ReadCommitted',maxWait:5000,timeout:15000})
async function state(id=productIds[0]){
  const p=await prisma.product.findUniqueOrThrow({where:{id},include:{variants:{orderBy:{id:'asc'}}}})
  if(p.inventoryConfigured)assert.equal(p.stock,p.variants.filter(v=>v.isActive).reduce((sum,v)=>sum+v.stock,0),'Aggregate must equal active variant stock')
  return p
}
async function main(){
 try{
  await prisma.category.create({data:{id:categoryId,name:prefix,slug:prefix.toLowerCase()}})
  await prisma.user.create({data:{id:userId,email:prefix.toLowerCase()+'@inventory-test.invalid',name:'آزمایش داخلی موجودی',password:'$disabled$temporary-test-account'}})
  await prisma.product.createMany({data:productIds.map((id,i)=>({id,name:'آزمایش داخلی موجودی',slug:id.toLowerCase(),description:'موقت',price:100,categoryId,stock:i?7:11,...dims}))})
  await tx(client=>configureInventory(client,productIds[0],rows,0,dims))
  const configured=await state();assert.equal(configured.inventoryVersion,1)
  const attempts=await Promise.allSettled([1,2].map(()=>tx(client=>reserveInventory(client,[item()]))))
  assert.equal(attempts.filter(result=>result.status==='fulfilled').length,1)
  const winner=attempts.find(result=>result.status==='fulfilled').value.get(inventoryKey(productIds[0],38,'مشکی'))
  const reserved=await state();assert.equal(reserved.variants.find(v=>v.id===winner).stock,0);assert.equal(reserved.variants.find(v=>v.size===38&&v.color==='کرم').stock,8)
  console.log('PASS real concurrent checkouts cannot consume another color or oversell the final selected variant')
  await assert.rejects(tx(client=>configureInventory(client,productIds[0],rows,1,dims)),error=>error.code==='PRODUCT_INVENTORY_CHANGED')
  assert.equal((await state()).stock,10)
  console.log('PASS stale admin inventory version cannot overwrite a concurrent reservation')
  await tx(client=>releaseInventory(client,[item({variantId:winner})]))
  assert.equal((await state()).stock,11)
  const before=await state(),forced=new Error('forced fixture rollback')
  await assert.rejects(tx(async client=>{await reserveInventory(client,[item(),item({color:'کرم'})]);throw forced}),error=>error===forced)
  assert.deepEqual(await state(),before)
  console.log('PASS failed transactions roll back every variant, aggregate and inventory version')
  await Promise.all([item(),item({color:'کرم',size:39})].map(entry=>tx(client=>reserveInventory(client,[entry]))))
  assert.equal((await state()).stock,9)
  await tx(client=>releaseInventory(client,[item(),item({color:'کرم',size:39})]))
  console.log('PASS concurrent distinct combinations and exact releases reconcile their aggregate')

  await prisma.order.create({data:{id:orderIds[0],userId,total:400,address:'آزمایش داخلی — بدون ارسال',phone:'00000000000',status:'CANCELLED',items:{create:[
    {productId:productIds[1],productName:'قدیمی',size:39,color:'مشکی',price:100,quantity:2},
    {productId:productIds[1],productName:'قدیمی',size:44,color:'سبز',price:100,quantity:2},
  ]}}})
  const legacy=await state(productIds[1]);assert.equal(legacy.stock,7);assert.equal(legacy.variants.length,0)
  const allocation=rows.map(row=>({...row,stock:row.size===38&&row.color==='کرم'?7:0}))
  await tx(client=>configureInventory(client,productIds[1],allocation,0,dims))
  const history=await prisma.orderItem.findMany({where:{orderId:orderIds[0]}})
  assert.ok(history.every(line=>line.variantId))
  await tx(client=>releaseInventory(client,history))
  const restored=await state(productIds[1]);assert.equal(restored.stock,9)
  assert.equal(restored.variants.find(v=>v.size===39&&v.color==='مشکی').stock,2)
  const retired=restored.variants.find(v=>v.size===44&&v.color==='سبز');assert.equal(retired.stock,2);assert.equal(retired.isActive,false)
  await assert.rejects(tx(client=>reserveInventory(client,[{...history.find(line=>line.color==='سبز'),quantity:1}],{allowLegacy:true})),error=>error.code==='STOCK_UNAVAILABLE')
  assert.equal((await state(productIds[1])).stock,9)
  console.log('PASS legacy conversion preserves history and returns retired units only to their original combination')
  await assert.rejects(prisma.productVariant.update({where:{id:winner},data:{stock:-1}}))
  await state()
  console.log('PASS PostgreSQL rejects negative variant inventory')
 }finally{
  await prisma.orderItem.deleteMany({where:{orderId:{in:orderIds}}})
  await prisma.order.deleteMany({where:{id:{in:orderIds}}})
  await prisma.stockMovement.deleteMany({where:{productId:{in:productIds}}})
  await prisma.productVariant.deleteMany({where:{productId:{in:productIds}}})
  await prisma.product.deleteMany({where:{id:{in:productIds}}})
  await prisma.category.deleteMany({where:{id:categoryId}})
  await prisma.user.deleteMany({where:{id:userId}})
  assert.equal(await prisma.product.count({where:{id:{in:productIds}}}),0)
  console.log('PASS exact temporary fixtures removed; existing products and orders untouched')
 }
}
main().catch(error=>{console.error(error.name,error.code||'',error.message);process.exitCode=1}).finally(()=>prisma.$disconnect())
