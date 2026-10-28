// Bun client/server fixture for Hunk-style HTTP and WebSocket traffic.
if (process.argv[2] === "server") {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      if (path === "/events" && server.upgrade(request)) return;
      if (path === "/sessions") return Response.json({ sessions: ["test-session"] });
      if (path === "/comment" && request.method === "POST") return Response.json({ comment: "accepted" });
      return new Response("not found", { status: 404 });
    },
    websocket: {
      message(socket, message) {
        if (message === "subscribe") socket.send("daemon-event");
      },
    },
  });
  console.log(JSON.stringify({ port: server.port }));
} else {
  const port = process.argv[3];
  const origin = `http://127.0.0.1:${port}`;
  const sessions = await fetch(`${origin}/sessions`).then((response) => response.json());
  const comment = await fetch(`${origin}/comment`, { method: "POST", body: "review note" })
    .then((response) => response.json());
  const event = await new Promise((resolve, reject) => {
    // Bun WebSocket needs an explicit proxy; unlike fetch it ignores proxy environment variables.
    const options = process.argv[2] === "direct-client"
      ? undefined
      : { proxy: process.env.http_proxy ?? process.env.HTTP_PROXY };
    const socket = new WebSocket(`ws://127.0.0.1:${port}/events`, options);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("WebSocket event timed out"));
    }, 5000);
    socket.onopen = () => socket.send("subscribe");
    socket.onmessage = (message) => {
      clearTimeout(timer);
      socket.close();
      resolve(message.data);
    };
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error("WebSocket connection failed"));
    };
  }).catch((error) => {
    if (process.argv[2] !== "direct-client") throw error;
    return error.message;
  });
  console.log(JSON.stringify({ sessions, comment, event }));
}
