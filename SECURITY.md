# Security

This application exposes interactive local shell sessions. It binds to `127.0.0.1` and validates
Host and Origin headers. Do not expose its HTTP or WebSocket server through a network listener,
reverse proxy, or public tunnel.

Provider credentials remain owned by their installed CLIs. The application does not read, copy, or
store them.

Please report security issues privately to the repository owner rather than opening a public issue.
