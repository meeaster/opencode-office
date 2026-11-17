// The artifacts site's script: the theme picker and colour scheme switch on every page, and search,
// sort and copy link on the index. Without it the site still works, in its default theme, so
// build-site.ts renders these controls hidden and this script shows them.
(() => {
  const root = document.documentElement;

  function load(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  // Storage throws where it is blocked; the choice then lasts only for this page.
  function save(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {}
  }

  function setUpAppearance(controls) {
    const button = controls.querySelector(".picker-button");
    const name = button.querySelector(".picker-name");
    const list = controls.querySelector("[role=listbox]");
    const options = [...list.querySelectorAll("[role=option]")];
    let committed = root.dataset.theme;
    let active = 0;

    const label = (option) => option.querySelector(".name").textContent;

    function show(id) {
      root.dataset.theme = id;
    }

    function activate(index) {
      active = index;

      for (const [i, option] of options.entries()) option.classList.toggle("active", i === index);

      list.setAttribute("aria-activedescendant", options[index].id);
      options[index].scrollIntoView({ block: "nearest" });
      show(options[index].dataset.id);
    }

    function committedIndex() {
      return Math.max(0, options.findIndex((option) => option.dataset.id === committed));
    }

    function mark() {
      for (const option of options) option.setAttribute("aria-selected", String(option.dataset.id === committed));

      name.textContent = label(options[committedIndex()]);
    }

    function open() {
      list.hidden = false;
      button.setAttribute("aria-expanded", "true");
      activate(committedIndex());
      list.focus();
    }

    function close(commit) {
      if (list.hidden) return;

      if (commit) {
        committed = options[active].dataset.id;
        save("artifact-share:theme", committed);
        mark();
      }

      show(committed);
      list.hidden = true;
      button.setAttribute("aria-expanded", "false");
    }

    button.addEventListener("click", () => (list.hidden ? open() : close(false)));

    button.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;

      event.preventDefault();
      open();
    });

    list.addEventListener("keydown", (event) => {
      const moves = { ArrowDown: active + 1, ArrowUp: active - 1, Home: 0, End: options.length - 1, PageDown: active + 5, PageUp: active - 5 };

      if (event.key in moves) {
        event.preventDefault();
        activate(Math.min(options.length - 1, Math.max(0, moves[event.key])));
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        close(true);
        button.focus();
      } else if (event.key === "Escape") {
        event.preventDefault();
        close(false);
        button.focus();
      } else if (event.key.length === 1) {
        // Type a letter to jump to the next theme starting with it.
        const letter = event.key.toLowerCase();
        const next = options.findIndex((option, i) => i > active && label(option).toLowerCase().startsWith(letter));
        const first = options.findIndex((option) => label(option).toLowerCase().startsWith(letter));

        if (next >= 0 || first >= 0) activate(next >= 0 ? next : first);
      }
    });

    for (const [i, option] of options.entries()) {
      option.addEventListener("pointermove", () => {
        if (active !== i || root.dataset.theme !== option.dataset.id) activate(i);
      });

      option.addEventListener("click", () => {
        activate(i);
        close(true);
        button.focus();
      });
    }

    // Moving the pointer off the list goes back to the chosen theme until another is pointed at.
    list.addEventListener("pointerleave", () => {
      if (!list.hidden) activate(committedIndex());
    });

    list.addEventListener("focusout", (event) => {
      if (!controls.contains(event.relatedTarget)) close(false);
    });

    document.addEventListener("pointerdown", (event) => {
      if (!controls.querySelector(".picker").contains(event.target)) close(false);
    });

    mark();

    const scheme = root.dataset.scheme ?? "system";

    for (const radio of controls.querySelectorAll("input[name=scheme]")) {
      radio.checked = radio.value === scheme;

      radio.addEventListener("change", () => {
        if (radio.value === "system") delete root.dataset.scheme;
        else root.dataset.scheme = radio.value;

        save("artifact-share:scheme", radio.value === "system" ? null : radio.value);
      });
    }

    controls.hidden = false;
  }

  function setUpIndex(tools) {
    const shelf = document.querySelector(".shelf");
    const items = [...shelf.children];
    const search = tools.querySelector("input[type=search]");
    const sort = tools.querySelector("select");
    const status = document.querySelector(".status");
    const empty = document.querySelector(".empty");
    const text = new Map(items.map((item) => [item, `${item.querySelector("h2").textContent} ${item.querySelector("p")?.textContent ?? ""} ${item.dataset.name}`.toLowerCase()]));
    const title = (item) => item.querySelector("h2").textContent.trim();

    function filter() {
      const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      let shown = 0;

      for (const item of items) {
        item.hidden = !words.every((word) => text.get(item).includes(word));

        if (!item.hidden) shown += 1;
      }

      empty.hidden = shown > 0;
      empty.textContent = `No artifacts match “${search.value.trim()}”.`;
      status.textContent = words.length === 0 ? "" : `${shown} of ${items.length} artifacts match`;
    }

    // Undated (uncommitted) artifacts go last in both date orders.
    const orders = {
      newest: (a, b) => (b.dataset.date || "").localeCompare(a.dataset.date || "") || a.dataset.name.localeCompare(b.dataset.name),
      oldest: (a, b) => (a.dataset.date || "￿").localeCompare(b.dataset.date || "￿") || a.dataset.name.localeCompare(b.dataset.name),
      title: (a, b) => title(a).localeCompare(title(b), undefined, { sensitivity: "base", numeric: true }),
    };

    function order() {
      shelf.append(...[...items].sort(orders[sort.value]));
    }

    const saved = load("artifact-share:sort");

    if (saved in orders) sort.value = saved;

    order();
    search.addEventListener("input", filter);

    search.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || search.value === "") return;

      search.value = "";
      filter();
    });

    sort.addEventListener("change", () => {
      save("artifact-share:sort", sort.value);
      order();
    });

    document.addEventListener("keydown", (event) => {
      const target = event.target;

      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName) || target.closest("[role=listbox]")) return;

      event.preventDefault();
      search.focus();
      search.select();
    });

    for (const button of shelf.querySelectorAll(".copy")) {
      button.addEventListener("click", async () => {
        const address = new URL(button.dataset.url, location.href).href;

        try {
          await navigator.clipboard.writeText(address);
          button.dataset.state = "copied";
          status.textContent = `Copied ${address}`;
        } catch {
          button.dataset.state = "failed";
          status.textContent = `Couldn't copy the link: ${address}`;
        }

        setTimeout(() => delete button.dataset.state, 1600);
      });

      button.hidden = false;
    }

    tools.hidden = false;
  }

  for (const controls of document.querySelectorAll(".appearance")) setUpAppearance(controls);

  const tools = document.querySelector(".tools");

  if (tools) setUpIndex(tools);
})();
