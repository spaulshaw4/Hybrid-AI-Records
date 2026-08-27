"""In-process WebSocket fan-out for live render progress."""

from __future__ import annotations

from fastapi import WebSocket


class ConnectionManager:
    def __init__(self) -> None:
        self.active_connections: dict[str, list[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, job_id: str) -> None:
        await websocket.accept()
        self.active_connections.setdefault(job_id, []).append(websocket)

    def disconnect(self, websocket: WebSocket, job_id: str) -> None:
        sockets = self.active_connections.get(job_id)
        if not sockets:
            return
        try:
            sockets.remove(websocket)
        except ValueError:
            return
        if not sockets:
            self.active_connections.pop(job_id, None)

    async def broadcast_progress(
        self,
        job_id: str,
        step: str,
        progress: float,
        message: str = "",
        **extra,
    ) -> None:
        payload = {
            "job_id": job_id,
            "step": step,
            "progress": progress,
            "message": message,
        }
        for key, value in extra.items():
            if value is not None:
                payload[key] = value
        stale: list[WebSocket] = []
        for websocket in list(self.active_connections.get(job_id, [])):
            try:
                await websocket.send_json(payload)
            except Exception:
                stale.append(websocket)
        for websocket in stale:
            self.disconnect(websocket, job_id)


manager = ConnectionManager()
