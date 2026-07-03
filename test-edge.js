// test-edge.js
// Call Twilio REST API directly using the new credentials to test validity

async function run() {
  const accountSid = 'ACa9a843c3410a82db219187d42f0cc36e';
  const authToken = '687f42097751565d4847897e3b737ee5';
  const from = '+16187536219';
  const to = '+919876543210'; // A phone number

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const authHeader = 'Basic ' + btoa(`${accountSid}:${authToken}`);
  
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        To: to,
        From: from,
        Body: 'Test direct call from Node with new credentials'
      })
    });
    
    console.log('Status:', res.status);
    const json = await res.json();
    console.log('Response:', json);
  } catch (err) {
    console.error('Error:', err);
  }
}

run();
