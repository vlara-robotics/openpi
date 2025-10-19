import asyncio
import http
import json
import logging
import time
import traceback
import base64

from openpi_client import base_policy as _base_policy
import websockets.asyncio.server as _server
import websockets.frames
import numpy as np

logger = logging.getLogger(__name__)


class WebsocketPolicyServerJSON:
    """Serves a policy using the websocket protocol with JSON communication.

    Updated to use JSON instead of msgpack for better compatibility with TypeScript clients.
    """

    def __init__(
        self,
        policy: _base_policy.BasePolicy,
        host: str = "0.0.0.0",
        port: int | None = None,
        metadata: dict | None = None,
    ) -> None:
        self._policy = policy
        self._host = host
        self._port = port
        self._metadata = metadata or {}
        logging.getLogger("websockets.server").setLevel(logging.INFO)

    def serve_forever(self) -> None:
        asyncio.run(self.run())

    async def run(self):
        async with _server.serve(
            self._handler,
            self._host,
            self._port,
            compression=None,
            max_size=None,
            process_request=_health_check,
        ) as server:
            await server.serve_forever()

    async def _handler(self, websocket: _server.ServerConnection):
        logger.info(f"Connection from {websocket.remote_address} opened")

        # Send metadata as JSON
        await websocket.send(json.dumps(self._metadata))

        prev_total_time = None
        while True:
            try:
                start_time = time.monotonic()

                # Receive JSON message
                message = await websocket.recv()
                obs = json.loads(message)

                # Convert base64 images to numpy arrays
                processed_obs = self._process_observation(obs)

                infer_time = time.monotonic()
                action = self._policy.infer(processed_obs)
                infer_time = time.monotonic() - infer_time

                action["server_timing"] = {
                    "infer_ms": infer_time * 1000,
                }
                if prev_total_time is not None:
                    # We can only record the last total time since we also want to include the send time.
                    action["server_timing"]["prev_total_ms"] = prev_total_time * 1000

                # Send response as JSON
                await websocket.send(json.dumps(action))
                prev_total_time = time.monotonic() - start_time

            except websockets.ConnectionClosed:
                logger.info(f"Connection from {websocket.remote_address} closed")
                break
            except Exception as e:
                error_response = {
                    "type": "error",
                    "message": str(e),
                    "traceback": traceback.format_exc()
                }
                await websocket.send(json.dumps(error_response))
                await websocket.close(
                    code=websockets.frames.CloseCode.INTERNAL_ERROR,
                    reason="Internal server error",
                )
                raise

    def _process_observation(self, obs: dict) -> dict:
        """Convert base64-encoded images to numpy arrays."""
        processed = {}

        for key, value in obs.items():
            if key.endswith('_image') and isinstance(value, str):
                # Decode base64 image data
                try:
                    image_data = base64.b64decode(value)
                    # Convert to numpy array (assuming 224x224x3 RGB images)
                    # Adjust dimensions based on your specific image format
                    image_array = np.frombuffer(image_data, dtype=np.uint8)
                    image_array = image_array.reshape(3, 224, 224)  # CHW format
                    processed[key] = image_array
                    logger.debug(f"Decoded image {key}: shape {image_array.shape}")
                except Exception as e:
                    logger.error(f"Failed to decode image {key}: {e}")
                    raise ValueError(f"Invalid base64 image data for {key}")
            else:
                # Keep other fields as-is
                processed[key] = value

        return processed


def _health_check(connection: _server.ServerConnection, request: _server.Request) -> _server.Response | None:
    if request.path == "/healthz":
        return connection.respond(http.HTTPStatus.OK, "OK\n")
    # Continue with the normal request handling.
    return None
