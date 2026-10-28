
(function () {
  "use strict";

  if (window.__pcInitialized) return;
  window.__pcInitialized = true;

  const PC = {
    version: "0.3.0",
    prices: {
      "2x6": 4.99,
      "4x6": 5.99,
      "5x7": 7.99
    },
    maxQuantity: 50
  };

  const state = {
    images: [],
    selection: "main",
    quantity: 1
  };

  const $ = (selector, root = document) =>
    root.querySelector(selector);

  const money = value => "$" + value.toFixed(2);

  function getFormat(width, height) {
    if (!width || !height) return null;

    const ratio = Math.max(width, height) /
                  Math.min(width, height);

    const formats = [
      { name: "2x6", ratio: 3 },
      { name: "4x6", ratio: 1.5 },
      { name: "5x7", ratio: 1.4 }
    ];

    const match = formats.find(item =>
      Math.abs(ratio / item.ratio - 1) <= 0.025
    );

    return match ? match.name : null;
  }

  function getMedia() {
    if ($("video")) return null;

    const main = $("#guest_main_url");
    const original = $("#guest_second_url");

    const mainURL = main?.currentSrc || main?.src || "";
    const originalURL =
      original?.currentSrc || original?.src || "";

    if (!mainURL.includes("/photo/still/")) {
      return null;
    }

    const originalAvailable =
      !!$('a#ai[data-toggle="pill"]') &&
      !!$('a#photo[data-toggle="pill"]') &&
      originalURL.includes("/media/download/photo/") &&
      originalURL !== mainURL;

    const images = [{
      id: "main",
      label: originalAvailable ? "AI Photo" : "Your Photo",
      url: mainURL,
      element: main
    }];

    if (originalAvailable) {
      images.push({
        id: "original",
        label: "Original Photo",
        url: originalURL,
        element: original
      });
    }

    return images;
  }

  function inspectImage(item) {
    return new Promise(resolve => {
      const element = item.element;

      // Prefer Snappic's already-loaded image dimensions.
      if (element?.naturalWidth && element?.naturalHeight) {
        const format = getFormat(
          element.naturalWidth,
          element.naturalHeight
        );

        resolve({
          id: item.id,
          label: item.label,
          url: item.url,
          format
        });
        return;
      }

      const image = new Image();

      image.onload = () => {
        resolve({
          id: item.id,
          label: item.label,
          url: item.url,
          format: getFormat(
            image.naturalWidth,
            image.naturalHeight
          )
        });
      };

      image.onerror = () => resolve(null);
      image.src = item.url;
    });
  }

  async function prepareImages() {
    const media = getMedia();
    if (!media) return [];

    const results = await Promise.all(
      media.map(inspectImage)
    );

    console.table(results.map(item => ({
      image: item?.label,
      format: item?.format,
      url: item?.url
    })));

    return results.filter(item => item?.format);
  }

  function selectedImages() {
    if (state.selection === "both") {
      return state.images;
    }

    return state.images.filter(
      image => image.id === state.selection
    );
  }

  function updateModal() {
    const images = selectedImages();
    const preview = $("#pc-preview-area");

    preview.replaceChildren();

    images.forEach(image => {
      const img = document.createElement("img");
      img.src = image.url;
      img.alt = image.label;
      img.className = "pc-preview-image";
      preview.appendChild(img);
    });

    const choices = $("#pc-choices");
    choices.replaceChildren();

    if (state.images.length > 1) {
      const options = [
        { id: "main", label: "AI Photo" },
        { id: "original", label: "Original Photo" },
        { id: "both", label: "Both Photos" }
      ];

      options.forEach(option => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "pc-choice" +
          (state.selection === option.id
            ? " pc-selected"
            : "");

        button.textContent = option.label;

        button.addEventListener("click", () => {
          state.selection = option.id;
          updateModal();
        });

        choices.appendChild(button);
      });
    }

    const formatNames = [...new Set(
      images.map(image => image.format)
    )];

    $("#pc-format").textContent =
      formatNames.map(format =>
        format.replace("x", "×")
      ).join(" + ") + " Print";

    const unitTotal = images.reduce(
      (sum, image) => sum + PC.prices[image.format],
      0
    );

    $("#pc-unit-price").textContent =
      money(unitTotal);

    $("#pc-quantity").textContent = state.quantity;

    $("#pc-subtotal").textContent =
      money(unitTotal * state.quantity);

    $("#pc-print-count").textContent =
      (images.length * state.quantity) + " total print" +
      (images.length * state.quantity === 1 ? "" : "s");
  }

  function openModal() {
    state.selection = "main";
    state.quantity = 1;

    $("#pc-overlay").hidden = false;
    document.body.classList.add("pc-modal-open");

    updateModal();
  }

  function closeModal() {
    $("#pc-overlay").hidden = true;
    document.body.classList.remove("pc-modal-open");
  }

  function buildUI() {
    if ($("#pc-buy-button")) return;

    const host = $(".photo-gif-cover");
    if (!host) return;

    const button = document.createElement("button");
    button.id = "pc-buy-button";
    button.type = "button";
    button.textContent = "Order Additional Prints";
    button.addEventListener("click", openModal);

    const buttonWrap = document.createElement("div");
    buttonWrap.className = "pc-button-wrap";
    buttonWrap.appendChild(button);
    host.appendChild(buttonWrap);

    const overlay = document.createElement("div");
    overlay.id = "pc-overlay";
    overlay.hidden = true;

    overlay.innerHTML = `
      <div class="pc-dialog" role="dialog"
           aria-modal="true"
           aria-label="Order Additional Prints">

        <button type="button" class="pc-close"
                aria-label="Close">×</button>

        <h2 class="pc-title">Order Additional Prints</h2>

        <p class="pc-description">
          Get extra copies of your event photo
          delivered to your door.
        </p>

        <div id="pc-choices" class="pc-choices"></div>

        <div id="pc-preview-area"
             class="pc-preview-wrap"></div>

        <div class="pc-details">
          <div>
            <span class="pc-muted">Print format</span>
            <strong id="pc-format"></strong>
          </div>

          <div>
            <span class="pc-muted">Price per selection</span>
            <strong id="pc-unit-price"></strong>
          </div>
        </div>

        <div class="pc-quantity-row">
          <span>Quantity / Sets</span>

          <div class="pc-stepper">
            <button id="pc-minus" type="button">−</button>
            <strong id="pc-quantity">1</strong>
            <button id="pc-plus" type="button">+</button>
          </div>
        </div>

        <div class="pc-total">
          <div>
            <span>Subtotal</span>
            <div id="pc-print-count"
                 class="pc-muted"></div>
          </div>

          <strong id="pc-subtotal"></strong>
        </div>

        <button id="pc-checkout" type="button">
          Continue to Checkout
        </button>

        <p class="pc-shipping">
          Shipping calculated at checkout.
        </p>
      </div>
    `;

    document.body.appendChild(overlay);

    $(".pc-close", overlay).addEventListener(
      "click", closeModal
    );

    overlay.addEventListener("click", event => {
      if (event.target === overlay) closeModal();
    });

    $("#pc-minus").addEventListener("click", () => {
      state.quantity = Math.max(
        1,
        state.quantity - 1
      );
      updateModal();
    });

    $("#pc-plus").addEventListener("click", () => {
      state.quantity = Math.min(
        PC.maxQuantity,
        state.quantity + 1
      );
      updateModal();
    });

    $("#pc-checkout").addEventListener("click", () => {
      const images = selectedImages();

      const subtotal = images.reduce(
        (sum, image) => sum + PC.prices[image.format],
        0
      ) * state.quantity;

      alert(
        "Print Commerce — Test Mode\n\n" +
        "Selection: " + state.selection + "\n" +
        "Quantity: " + state.quantity + "\n" +
        "Total prints: " +
        (images.length * state.quantity) + "\n" +
        "Subtotal: " + money(subtotal) +
        "\n\nStripe checkout will be connected later."
      );
    });

    document.addEventListener("keydown", event => {
      if (event.key === "Escape") closeModal();
    });
  }

  async function init() {
    console.log(
      "[Print Commerce] Initialized",
      PC.version
    );

    for (let attempt = 0; attempt < 15; attempt++) {
      if ($(".photo-gif-cover") && $("#guest_main_url")) {
        break;
      }

      await new Promise(resolve =>
        setTimeout(resolve, 200)
      );
    }

    // Wait for Snappic to finish loading AI/original media.
let detectedImages = [];

for (let attempt = 0; attempt < 20; attempt++) {
  detectedImages = await prepareImages();

  const hasOriginalTab =
    !!document.querySelector('a#ai[data-toggle="pill"]') &&
    !!document.querySelector('a#photo[data-toggle="pill"]');

  const originalElement =
    document.querySelector("#guest_second_url");

  const originalReady =
    originalElement?.naturalWidth > 0 &&
    originalElement?.naturalHeight > 0;

  // Standard photo: one image is expected.
  // AI photo: wait until both images are ready.
  if (
    detectedImages.length > 0 &&
    (!hasOriginalTab ||
      (originalReady && detectedImages.length === 2))
  ) {
    break;
  }

  await new Promise(resolve =>
    setTimeout(resolve, 250)
  );
}

state.images = detectedImages;

if (!state.images.length) {
  console.log(
    "[Print Commerce] No supported printable media."
  );
  return;
}

buildUI();

    console.log(
      "[Print Commerce] Ready:",
      state.images.length,
      "printable image(s)"
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
