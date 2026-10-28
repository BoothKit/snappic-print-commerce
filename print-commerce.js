
(function () {
  "use strict";

  if (window.__pcInitialized) return;
  window.__pcInitialized = true;

  const PC = {
    version: "0.2.0",
    prices: {
      "2x6": 4.99,
      "4x6": 5.99,
      "5x7": 7.99
    },
    maxQuantity: 50
  };

  const state = {
    images: [],
    selected: 0,
    quantity: 1
  };

  function $(selector, root = document) {
    return root.querySelector(selector);
  }

  function money(value) {
    return "$" + value.toFixed(2);
  }

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

  function loadImage(url) {
    return new Promise(resolve => {
      const img = new Image();

      img.onload = () => resolve({
        url,
        width: img.naturalWidth,
        height: img.naturalHeight,
        format: getFormat(
          img.naturalWidth,
          img.naturalHeight
        )
      });

      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  function getMedia() {
    if ($("video")) return null;

    const main = $("#guest_main_url");
    const second = $("#guest_second_url");

    const mainURL = main?.currentSrc || main?.src || "";
    const secondURL = second?.currentSrc || second?.src || "";

    if (!mainURL.includes("/photo/still/")) {
      return null;
    }

    const originalAvailable =
      !!$('a#ai[data-toggle="pill"]') &&
      !!$('a#photo[data-toggle="pill"]') &&
      secondURL.includes("/media/download/photo/") &&
      secondURL !== mainURL;

    const images = [{
      label: originalAvailable ? "AI Photo" : "Your Photo",
      url: mainURL
    }];

    if (originalAvailable) {
      images.push({
        label: "Original Photo",
        url: secondURL
      });
    }

    return images;
  }

  async function prepareImages() {
    const media = getMedia();
    if (!media) return [];

    const results = await Promise.all(
      media.map(async item => {
        const image = await loadImage(item.url);
        if (!image?.format) return null;

        return {
          ...item,
          ...image
        };
      })
    );

    return results.filter(Boolean);
  }

  function updateModal() {
    const image = state.images[state.selected];
    if (!image) return;

    $("#pc-preview").src = image.url;
    $("#pc-format").textContent =
      image.format.replace("x", "×") + " Print";

    $("#pc-unit-price").textContent =
      money(PC.prices[image.format]);

    $("#pc-quantity").textContent = state.quantity;

    $("#pc-subtotal").textContent = money(
      PC.prices[image.format] * state.quantity
    );

    const choices = $("#pc-choices");
    choices.replaceChildren();

    if (state.images.length > 1) {
      state.images.forEach((item, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "pc-choice" +
          (index === state.selected ? " pc-selected" : "");
        button.textContent = item.label;

        button.addEventListener("click", () => {
          state.selected = index;
          updateModal();
        });

        choices.appendChild(button);
      });
    }
  }

  function openModal() {
    state.selected = 0;
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

        <div class="pc-preview-wrap">
          <img id="pc-preview" alt="Your event photo">
        </div>

        <div class="pc-details">
          <div>
            <span class="pc-muted">Print format</span>
            <strong id="pc-format"></strong>
          </div>
          <div>
            <span class="pc-muted">Price per print</span>
            <strong id="pc-unit-price"></strong>
          </div>
        </div>

        <div class="pc-quantity-row">
          <span>Quantity</span>
          <div class="pc-stepper">
            <button id="pc-minus" type="button">−</button>
            <strong id="pc-quantity">1</strong>
            <button id="pc-plus" type="button">+</button>
          </div>
        </div>

        <div class="pc-total">
          <span>Subtotal</span>
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
      state.quantity = Math.max(1, state.quantity - 1);
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
      const image = state.images[state.selected];

      alert(
        "Print Commerce — Test Mode\n\n" +
        "Format: " + image.format + "\n" +
        "Quantity: " + state.quantity + "\n" +
        "Subtotal: " +
        money(PC.prices[image.format] * state.quantity) +
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

    // Allow Snappic's photo content to load.
    for (let attempt = 0; attempt < 15; attempt++) {
      if ($(".photo-gif-cover") && $("#guest_main_url")) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    state.images = await prepareImages();

    if (!state.images.length) {
      console.log(
        "[Print Commerce] No supported printable media."
      );
      return;
    }

    buildUI();

    console.log(
      "[Print Commerce] Available formats:",
      state.images.map(image => image.format)
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
