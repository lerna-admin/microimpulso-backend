const axios = require('axios');
const clients = require('./clients.json');

async function insertClients() {
  for (const client of clients) {
    try {
      const response = await axios.post('http://localhost:3100/client', client, {
        headers: {
          'Content-Type': 'application/json',
        },
      });
      console.log(`✅ Inserted client: ${client.fullName}`);
    } catch (error) {
      console.error(`❌ Failed to insert client: ${client.fullName}`);
      console.error(error.response?.data || error.message);
    }
  }
}

insertClients();
