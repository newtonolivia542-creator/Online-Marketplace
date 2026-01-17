const express = require("express");
const app = express();
const PORT = 5000;

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Backend running");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
