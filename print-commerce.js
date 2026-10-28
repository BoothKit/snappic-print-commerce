
(function () {
  "use strict";

  // Snappic Print Commerce
  // Version: 0.1.0
  // Guest-facing application

  const PC = {
    version: "0.1.0",
    supportedFormats: ["2x6", "4x6", "5x7"],
    debug: true
  };

  function init() {
    if (PC.debug) {
      console.log(
        "[Print Commerce] Initialized",
        PC.version
      );
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
      
