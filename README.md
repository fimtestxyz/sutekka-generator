# sutekka-generator

Sutekka （すてっか, sticker) generator — a cute cartoon sticker generator.

The art style for everything this repo generates is defined by one reference
image: [`art-style/reference.jpg`](art-style/reference.jpg).

## The art style

From the reference (a 30-piece cute cartoon sticker pack sheet):

- **Characters:** chibi cartoon animals — penguins, dogs, cats, gorilla,
  peacock, mammoth, monkey, hedgehog, crocodile, blobfish-like pink creature,
  and more. One character per sticker, each a different design (no repeats).
- **Line work:** thick, rounded black outlines; simple flat colour fills.
- **Palette:** soft pastels with a few saturated accents (pink, teal, blue,
  orange); white background.
- **Sticker treatment:** every character has a white die-cut border, so each
  design reads as a peelable sticker.
- **Text:** short hand-lettered Japanese phrases next to the characters
  (speech / reaction lines). Text is part of the sticker, not a caption.
- **Layout:** dense collage sheet — many small stickers packed together,
  each self-contained.
- **Mood:** cute, playful, slightly deadpan — the humour is in the
  characters' expressions and the contrast with the text.

Any generator output should be checkable against this list: chibi animal,
thick outline, flat pastel colour, white die-cut border, short Japanese
reaction text, one design per sticker.

## Provenance

`art-style/reference.jpg` is a product photo of a commercial sticker pack
("Cute Tokyu Cartoon STICKERS PACK", NARGOS STUDIO SINGAPORE). It is stored
here as a **style reference only** — to define the look the generator aims
for. It is not source material to copy, trace, or redistribute, and the
characters in it belong to their maker.

## Layout

- `art-style/` — the style reference image and any future style notes.
- (generator code, prompts, and outputs to be added)
