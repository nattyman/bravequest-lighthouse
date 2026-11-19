/* =====================================================================
   BRAVE QUEST: LIGHTHOUSE — treekit.js
   The forest trees made in Blender (tools/florakit/build_trees.py, embedded in js/treekit_data.js as G.treekitData):
   four oaks, three pines and a dead snag, each as a trunk and a canopy at three levels of detail, with the colour
   (palette x baked occlusion) in the vertex colours and soft clump normals. world.js places and draws them.
   API: G.treekit = { oaks:[{name,trunk:[g0,g1,g2],canopy:[g0,g1,g2],h}], pines:[…], extras:{snag:{trunk:[…],canopy:null,h}},
                      stats:{bytes,ms,tris:{name:[lod0,lod1,lod2]}} }   (geometries: position, normal, color; y up, origin at the foot)
   ===================================================================== */
(function(){
'use strict';
const G=window.G, THREE=G.THREE, D=G.treekitData;
if(!D){ return; }
const t0=performance.now();
function b64(s,T){ const bin=atob(s), u8=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i); return new T(u8.buffer); }
const LIN=new Float32Array(256); for(let i=0;i<256;i++){ const v=i/255; LIN[i]=v<=.04045?v/12.92:Math.pow((v+.055)/1.055,2.4); }
let bytes=0;
function geo(d){
  if(!d)return null; bytes+=d.p.length+d.n.length+d.c.length+d.i.length;
  const q=b64(d.p,Int16Array), nq=b64(d.n,Int8Array), cq=b64(d.c,Uint8Array), ix=b64(d.i,Uint16Array), n=q.length/3;
  const pos=new Float32Array(n*3), nor=new Float32Array(n*3), col=new Float32Array(n*3);
  const s0=d.size[0]/65535, s1=d.size[1]/65535, s2=d.size[2]/65535, m0=d.min[0]+32768*s0, m1=d.min[1]+32768*s1, m2=d.min[2]+32768*s2;
  for(let i=0;i<n*3;i+=3){ pos[i]=m0+q[i]*s0; pos[i+1]=m1+q[i+1]*s1; pos[i+2]=m2+q[i+2]*s2; }
  for(let i=0;i<n*3;i++){ nor[i]=nq[i]/127; col[i]=LIN[cq[i]]; }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.BufferAttribute(pos,3)); g.setAttribute('normal',new THREE.BufferAttribute(nor,3));
  g.setAttribute('color',new THREE.BufferAttribute(col,3)); g.setIndex(new THREE.BufferAttribute(ix,1));
  g.computeBoundingBox(); g.computeBoundingSphere(); return g;
}
const tris={};
function form(f){
  const o={name:f.name,h:f.h,trunk:f.lods.map(L=>geo(L.trunk)),canopy:f.lods[0].canopy?f.lods.map(L=>geo(L.canopy)):null};
  tris[f.name]=f.lods.map(L=>L.trunk.tris+(L.canopy?L.canopy.tris:0)); return o;
}
const K=G.treekit={oaks:D.oaks.map(form),pines:D.pines.map(form),extras:{},stats:{}};
for(const k in D.extras)K.extras[k]=form(D.extras[k]);
K.stats={bytes,ms:Math.round((performance.now()-t0)*10)/10,tris};
})();
