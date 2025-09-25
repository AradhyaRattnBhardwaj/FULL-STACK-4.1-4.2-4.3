const express = require("express");
const app = express();
const PORT = 3000;

// Middleware to parse JSON request bodies
app.use(express.json());

// In-memory card storage
let cards = [
  { id: 1, suit: "Hearts", value: "Ace" },
  { id: 2, suit: "Spades", value: "King" },
];

// ================= ROUTES =================

// Get all cards
app.get("/cards", (req, res) => {
  res.json(cards);
});

// Get a single card by ID
app.get("/cards/:id", (req, res) => {
  const cardId = parseInt(req.params.id);
  const card = cards.find((c) => c.id === cardId);

  if (!card) {
    return res.status(404).json({ message: "Card not found" });
  }
  res.json(card);
});

// Create a new card
app.post("/cards", (req, res) => {
  const { suit, value } = req.body;

  if (!suit || !value) {
    return res.status(400).json({ message: "Suit and value are required" });
  }

  const newCard = {
    id: cards.length ? cards[cards.length - 1].id + 1 : 1,
    suit,
    value,
  };

  cards.push(newCard);
  res.status(201).json(newCard);
});

// Update an existing card
app.put("/cards/:id", (req, res) => {
  const cardId = parseInt(req.params.id);
  const card = cards.find((c) => c.id === cardId);

  if (!card) {
    return res.status(404).json({ message: "Card not found" });
  }

  const { suit, value } = req.body;
  if (suit) card.suit = suit;
  if (value) card.value = value;

  res.json(card);
});

// Delete a card
app.delete("/cards/:id", (req, res) => {
  const cardId = parseInt(req.params.id);
  const index = cards.findIndex((c) => c.id === cardId);

  if (index === -1) {
    return res.status(404).json({ message: "Card not found" });
  }

  const deleted = cards.splice(index, 1);
  res.json(deleted[0]);
});

// ================= START SERVER =================
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
