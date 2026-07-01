const express = require("express");
const twilio = require("twilio");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

app.post("/send-bulk-sms", async (req, res) => {

  const { recipients, message } = req.body;

  const results = [];

  for(const phone of recipients){

    try{

      const sms =
        await client.messages.create({
          body: message,
          from: process.env.TWILIO_PHONE,
          to: phone
        });

      results.push({
        phone,
        success: true,
        sid: sms.sid
      });

    }catch(error){

      results.push({
        phone,
        success: false,
        error: error.message
      });

    }

  }

  res.json(results);

});

app.listen(5000);