self.addEventListener('install',event=>{
event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate',event=>{
event.waitUntil((async()=>{
const cacheNames=await caches.keys();
await Promise.all(cacheNames.map(name=>caches.delete(name).catch(()=>false)));
const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
await self.clients.claim();
await self.registration.unregister().catch(()=>false);
await Promise.all(clients.map(client=>client.navigate(client.url).catch(()=>null)));
})());
});
