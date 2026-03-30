// |jit-test| skip-if: !getBuildConfiguration("source-phase-imports"); --enable-source-phase-imports

load(libdir + "asserts.js");

// import.source on a JavaScript module should reject with a SyntaxError.
let error;
import.source("empty.js").then(
  () => {
    throw new Error("import.source should have been rejected");
  },
  (e) => {
    error = e;
  }
);

drainJobQueue();

assertEq(error instanceof SyntaxError, true);
