gczeal(0);
new Uint8Array(512);
[Uint8Array,[9]];
const v9 = new SharedArrayBuffer(8, { maxByteLength: 255 });
new Float64Array(v9);
const v16 = new ArrayBuffer(1024, { maxByteLength: 3422723342 });
new Int32Array(v16);
function f19(a20) {
  actual += a20 + ",";
}
var appendToActual = f19;
for (const v45 of ["gczeal","unsetgczeal","schedulegc","selectforgc","verifyprebarriers","verifypostbarriers","currentgc","deterministicgc","dumpGCArenaInfo","setMarkStackLimit","oomThreadTypes","oomAfterAllocations","oomAtAllocation","resetOOMFailure","oomTest","stackTest","interruptTest"]) {
  const present = v45 in this;
  if (!present) {
    function f50() {
    }
    this[v45] = f50;
  }
}
gcparam("parallelMarkingThresholdMB", 0);
var g1 = newGlobal();
var g2 = newGlobal({ sameZoneAs: g1 });
g2.evaluate("enableTrackAllocations()");

for (let i = 0; i < 30; i++) {
  const v66 = () => {
    let objects = [];
    objects.push(newObjectWithCallHook());
    objects.push(createIsHTMLDDA());
    objects.push(g1);
    objects.push(g2);
    const v82 = new WeakSet(objects);
    assertEq(v82.has(createIsHTMLDDA()), false);
    assertEq(v82.delete(createIsHTMLDDA()), false);
    objects = gc();
    objects = null;
    gc();
  };
  var f = v66;
  try { f(); } catch (e) {}
  oomTest(f, { keepFailing: true });
  const v101 = transplantableObject();
  const v102 = v101.object;
  Object.defineProperty(v102, "e", { writable: true, value: v102 });
  v102.e = v102;
  v101.transplant(newGlobal({ newCompartment: true }));
}
