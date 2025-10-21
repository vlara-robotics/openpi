const fs = require('fs');
const WebSocket = require('ws');
const sharp = require('sharp');
const readline = require('readline');

// Update these as needed
const imagePath = './twotwentyfour.png';
const hostname = '4d4u3mlbph57lw-8000.proxy.runpod.net';
const port = '443';
const url = `wss://${hostname}:${port}`;

// Setup readline for keyboard input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

(async () => {
  let base64Image;
  try {
    // Load image with sharp, resize to 224x224, ensure RGB only (no alpha channel)
    const image = sharp(imagePath);
    const buffer = await image
      .resize(224, 224)
      .removeAlpha()  // Remove alpha channel to ensure RGB-only (3 channels)
      .raw()
      .toBuffer();

    // buffer is Uint8Array of HWC (224*224*3 = 150,528 bytes)
    const pixels = new Uint8Array(buffer);
    const chw = new Uint8Array(224 * 224 * 3);

    // Transpose HWC to CHW (required by server)
    let idx = 0;
    for (let c = 0; c < 3; c++) {
      for (let h = 0; h < 224; h++) {
        for (let w = 0; w < 224; w++) {
          chw[idx++] = pixels[h * 224 * 3 + w * 3 + c];
        }
      }
    }

    // Send the CHW-formatted data (3, 224, 224)
    base64Image = Buffer.from(chw).toString('base64');

  } catch (err) {
    console.error('Error processing image:', err);
    process.exit(1);
  }

  const ws = new WebSocket(url);

  ws.on('open', () => {
    console.log('WebSocket connection established');
    console.log('Press Enter to close connection...');

    // Listen for Enter key to close connection
    rl.on('line', () => {
      console.log('Closing WebSocket connection...');
      ws.close();
      rl.close();
    });

    // Send observations at a rate of every 1 second
    const interval = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        clearInterval(interval);
        return;
      }
      const observation = {
        prompt: 'pick up the fork',  // Example prompt; adjust as needed for LIBERO tasks
        'observation/image': base64Image,
        'observation/wrist_image': base64Image,
        'observation/state': [0, 0, 0, 0, 0, 0, 0, 0]  // Simulated state vector (8D for LIBERO)
      };

      ws.send(JSON.stringify(observation));
      console.log('Sent observation');
    }, 1000);

    ws.on('close', () => {
      clearInterval(interval);
    });
  });

  ws.on('message', (data) => {
    try {
      const response = JSON.parse(data);

      // Check if this is an error response
      if (response.type === 'error') {
        console.error('=== SERVER ERROR ===');
        console.error('Message:', response.message);
        console.error('Full traceback:');
        console.error(response.traceback);
        console.error('===================');
        return;
      }

      console.log('Received response:', JSON.stringify(response, null, 2));

      if (response.actions && Array.isArray(response.actions)) {
        response.actions.forEach((action, index) => {
          if (Array.isArray(action) && action.length === 7) {
            console.log(`Motor movements for action chunk ${index + 1}:`);
            action.forEach((value, motorIndex) => {
              console.log(`  Motor ${motorIndex + 1}: ${value}`);
            });
          } else {
            console.log('Unexpected action format:', action);
          }
        });
      } else {
        console.log('No actions found in response');
      }
    } catch (err) {
      console.error('Error parsing response:', err);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
})();
