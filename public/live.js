const view = document.body.dataset.view;
const output = document.querySelector("#state");

function show(value) {
  output.textContent = JSON.stringify(value, null, 2);
}

async function cardState() {
  const response = await fetch("/api/card");
  show(await response.json());
}

async function connect() {
  if (view === "card") await cardState();
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/ws?view=${view}`);
  socket.addEventListener("message", (event) => show(JSON.parse(event.data).data));
  socket.addEventListener("close", () => setTimeout(connect, 1_000));
}

document.querySelector("#claim")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const response = await fetch("/api/card/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ login: new FormData(event.currentTarget).get("login") }),
  });
  show(await response.json());
});

for (const button of document.querySelectorAll("[data-action]")) {
  button.addEventListener("click", async () => {
    const response = await fetch(`/api/host/${button.dataset.action}`, { method: "POST" });
    show(await response.json());
  });
}

connect();
