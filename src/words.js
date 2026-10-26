const WORD_GROUPS = {
  home: [
    "candle", "carpet", "pillow", "mirror", "window", "closet", "drawer",
    "kettle", "basket", "button", "blanket", "shower", "garden", "garage",
    "ladder", "hammer", "fridge", "toilet", "faucet", "sponge", "curtain",
    "remote",
  ],
  food: [
    "apple", "banana", "cherry", "cookie", "carrot", "pepper", "cheese",
    "butter", "noodle", "pickle", "tomato", "potato", "orange", "lemon",
    "muffin", "burger", "pizza", "cereal", "garlic", "onion", "yogurt",
    "waffle",
  ],
  animals: [
    "tiger", "rabbit", "turtle", "monkey", "panda", "horse", "sheep",
    "eagle", "shark", "whale", "otter", "beaver", "badger", "camel",
    "donkey", "kitten", "puppy", "parrot", "pigeon", "spider", "lizard",
    "beetle",
  ],
  nature: [
    "river", "ocean", "forest", "flower", "mountain", "valley", "desert",
    "island", "thunder", "breeze", "cloud", "meadow", "canyon", "pebble",
    "branch", "sunset", "sunrise", "winter", "summer", "autumn", "spring",
    "storm",
  ],
  travel: [
    "airport", "ticket", "passport", "suitcase", "hotel", "motel", "train",
    "subway", "ferry", "taxi", "route", "tunnel", "bridge", "station",
    "journey", "cruise", "flight", "pilot", "cabin", "compass", "border",
    "harbor",
  ],
  technology: [
    "laptop", "screen", "camera", "tablet", "router", "server", "cursor",
    "mouse", "cable", "socket", "battery", "charger", "signal", "browser",
    "modem", "printer", "speaker", "webcam", "robot", "drone", "pixel",
    "keypad",
  ],
  entertainment: [
    "movie", "music", "guitar", "piano", "comic", "puzzle", "circus",
    "actor", "singer", "ballet", "radio", "novel", "story", "stage",
    "drama", "comedy", "album", "rhythm", "cinema", "karaoke", "puppet",
    "arcade",
  ],
  sports: [
    "soccer", "tennis", "hockey", "golf", "boxing", "runner", "racing",
    "skate", "coach", "goalie", "tackle", "helmet", "jersey", "whistle",
    "medal", "trophy", "pitch", "court", "relay", "sprint", "paddle",
    "hiking",
  ],
  work: [
    "office", "meeting", "email", "coffee", "project", "report", "client",
    "pencil", "paper", "folder", "staple", "desk", "chair", "clock",
    "badge", "salary", "shift", "break", "task", "notes", "inbox",
    "invoice",
  ],
  people: [
    "doctor", "nurse", "teacher", "lawyer", "farmer", "baker", "driver",
    "artist", "author", "barber", "dancer", "sailor", "guard", "judge",
    "chef", "clerk", "parent", "cousin", "friend", "neighbor", "guest",
    "captain",
  ],
  clothing: [
    "shirt", "pants", "jacket", "sweater", "socks", "shoes", "boots",
    "scarf", "glove", "belt", "dress", "skirt", "pocket", "zipper",
    "collar", "sleeve", "hoodie", "shorts", "sandal", "uniform", "apron",
    "beanie",
  ],
  places: [
    "school", "library", "market", "bakery", "museum", "castle", "church",
    "clinic", "theater", "beach", "park", "plaza", "street", "village",
    "city", "prison", "palace", "factory", "stadium", "campus", "diner",
    "cafe",
  ],
  objects: [
    "bottle", "wallet", "keychain", "phone", "watch", "glasses", "scissors",
    "magnet", "lantern", "bucket", "broom", "rope", "chain", "coin",
    "brush", "comb", "plate", "bowl", "fork", "spoon", "knife", "napkin",
  ],
  feelings: [
    "happy", "angry", "nervous", "calm", "proud", "tired", "lonely",
    "brave", "sleepy", "silly", "lucky", "upset", "bored", "excited",
    "worried", "jealous", "gentle", "grumpy", "eager", "afraid", "curious",
    "quiet",
  ],
  colors: [
    "purple", "yellow", "silver", "golden", "black", "white", "brown",
    "green", "violet", "crimson", "coral", "peach", "amber", "ivory",
    "indigo", "bronze", "scarlet", "maroon", "beige", "copper", "rainbow",
    "turquoise",
  ],
  actions: [
    "whisper", "laugh", "smile", "dance", "jump", "climb", "build",
    "paint", "cook", "drive", "sleep", "dream", "shout", "wave", "blink",
    "carry", "chase", "throw", "catch", "knock", "crawl", "march",
  ],
  fantasy: [
    "dragon", "wizard", "pirate", "ghost", "fairy", "giant", "crown",
    "sword", "shield", "spell", "treasure", "knight", "potion", "goblin",
    "mermaid", "monster", "vampire", "zombie", "alien", "planet", "rocket",
    "space",
  ],
  events: [
    "birthday", "holiday", "picnic", "party", "wedding", "dinner", "lunch",
    "breakfast", "weekend", "morning", "evening", "midnight", "minute",
    "second", "season", "concert", "parade", "festival", "contest", "game",
    "secret", "surprise",
  ],
};

export const WORDS = Object.freeze(
  Object.entries(WORD_GROUPS).flatMap(([category, words]) =>
    words.map((word) => Object.freeze({ word, category })),
  ),
);

export const CATEGORIES = Object.freeze(Object.keys(WORD_GROUPS));

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findWord(message, word) {
  if (typeof message !== "string" || typeof word !== "string") {
    return { hit: false, index: -1, length: 0 };
  }

  const secret = word.toLowerCase();
  if (!/^[a-z]{4,9}$/.test(secret) || message.trimStart().startsWith("!")) {
    return { hit: false, index: -1, length: 0 };
  }

  const tokens = message.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
  if (tokens.length < 3) {
    return { hit: false, index: -1, length: 0 };
  }

  const forms = [
    `${secret}'s`,
    `${secret}’s`,
    `${secret}es`,
    `${secret}s`,
    secret,
  ];
  if (secret.endsWith("y")) {
    forms.unshift(`${secret.slice(0, -1)}ies`);
  }

  const pattern = forms
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join("|");
  const match = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${pattern})(?![\\p{L}\\p{N}_])`,
    "iu",
  )
    .exec(message);

  return match
    ? { hit: true, index: match.index, length: match[0].length }
    : { hit: false, index: -1, length: 0 };
}
