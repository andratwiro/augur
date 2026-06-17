/* ============================================================
   Piti — a tiny companion that trails your cursor.
   One source of truth, used by:
     • pitis/index.html        (adopt / customize page)
     • the prototypes-site shell  (build.js injects this file)
   The cat art is TRACED (potrace) from the real Piti resting
   pose — a loose, hand-drawn doodle, not regularised vector
   geometry. The traced silhouette + outline are recoloured per
   palette so the same iconic cat repaints into any hue.
   Exposes window.Piti =
     { PALETTE, HATS, svg, loadConfig, saveConfig, mount, auto, reveal, hide }.
   ============================================================ */
(function () {
  const OUT = "#241d29";   // outline (warm near-black) — stays dark in every palette

  // Figma-style pointer (dark arrow, white outline) shown site-wide while the piti
  // is active (Shift+Ñ on). Hotspot at the tip. Built as a cursor data-URI.
  const CURSOR_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="21" height="21" viewBox="0 0 912 892"><g transform="translate(0.000000,892.000000) scale(0.100000,-0.100000)"><path d="M2604 7445 c-38 -17 -89 -66 -111 -109 -19 -36 -20 -144 -4 -351 6 -71 16 -186 21 -255 5 -69 14 -181 20 -250 5 -69 21 -267 35 -440 32 -400 72 -900 85 -1055 5 -66 14 -181 20 -255 6 -74 15 -193 20 -265 6 -71 15 -188 20 -260 6 -71 15 -184 20 -250 5 -66 14 -183 20 -260 6 -77 15 -187 20 -245 6 -58 14 -168 20 -245 6 -77 15 -194 21 -260 5 -66 16 -201 24 -300 8 -99 19 -236 25 -305 6 -69 15 -183 20 -255 5 -71 15 -191 21 -265 6 -74 14 -180 18 -235 9 -117 26 -161 84 -210 64 -55 159 -71 235 -40 63 27 67 31 227 280 18 28 99 156 180 285 204 324 374 593 465 735 42 66 128 201 190 300 180 287 200 315 290 405 166 168 374 283 595 329 59 12 295 27 670 41 149 6 376 15 505 20 129 5 366 15 525 20 490 19 576 25 621 48 105 54 152 186 105 294 -24 55 -47 75 -216 192 -77 52 -207 142 -290 199 -82 57 -332 229 -555 382 -223 153 -443 305 -490 337 -47 32 -152 105 -235 161 -149 103 -421 290 -1063 732 -183 127 -393 271 -465 320 -73 50 -206 142 -297 205 -91 62 -235 161 -320 220 -85 59 -229 158 -320 220 -91 63 -228 157 -305 210 -77 53 -160 110 -185 129 -25 18 -60 39 -79 47 -42 18 -146 17 -187 -1z" fill="#0d0d0d" stroke="#ffffff" stroke-width="620" stroke-linejoin="round" stroke-linecap="round" paint-order="stroke"/></g></svg>';
  const CURSOR_URI = "data:image/svg+xml," + encodeURIComponent(CURSOR_SVG);

  /* ---- traced paths (potrace, viewBox 0 0 1744 720, transform below) ----
     sil      = full body silhouette (recoloured = fur)
     outMain  = the hand-drawn outline + ear/tail/body line
     eyeL/eyeR= the two closed sleepy-eye arcs
     nose     = the little nose
     Lighter belly, inner-ears, haunch stripes, heart-brow & blush are drawn
     as recolourable overlays clipped to the silhouette (the source has no hard
     belly edge — it's a single soft fur tone — so those are positioned shapes). */
  const P = {
    sil: "M3936 7022 c-45 -2 -66 -9 -87 -27 -16 -13 -42 -26 -59 -30 -16 -4 -42 -21 -57 -40 -16 -18 -53 -48 -83 -68 -61 -39 -121 -105 -143 -158 -8 -19 -36 -54 -62 -76 -25 -23 -44 -47 -40 -53 11 -18 -14 -75 -50 -110 -19 -18 -42 -55 -50 -81 -9 -27 -27 -63 -39 -82 -13 -19 -29 -50 -35 -70 -7 -20 -22 -51 -34 -69 -13 -18 -31 -54 -41 -80 -9 -26 -22 -50 -27 -53 -5 -4 -9 -19 -9 -34 0 -33 -34 -135 -55 -168 -8 -12 -15 -31 -15 -42 0 -24 -42 -171 -69 -246 -10 -27 -22 -77 -26 -110 -4 -33 -18 -93 -31 -133 -13 -40 -21 -79 -18 -86 3 -8 0 -34 -7 -57 -6 -24 -15 -87 -20 -139 -13 -138 -25 -221 -38 -254 -6 -16 -9 -36 -6 -45 3 -9 -2 -43 -10 -74 -8 -32 -15 -90 -15 -128 0 -51 -7 -88 -24 -132 -31 -78 -37 -191 -39 -742 -1 -389 5 -510 32 -578 6 -16 11 -42 11 -60 0 -42 19 -143 36 -190 19 -51 0 -98 -47 -117 -19 -8 -48 -26 -66 -41 -17 -15 -48 -33 -69 -39 -76 -25 -171 -100 -321 -251 -112 -114 -153 -162 -158 -186 -3 -18 -18 -49 -31 -69 -38 -55 -87 -166 -85 -190 1 -12 -5 -49 -13 -82 -37 -139 10 -348 110 -500 55 -82 265 -288 302 -297 16 -3 51 -19 76 -36 27 -17 60 -29 79 -29 18 0 59 -7 90 -15 80 -21 364 -21 444 0 31 8 80 15 108 15 34 0 66 8 100 26 34 17 59 23 78 20 29 -6 85 17 137 56 15 11 58 24 101 30 46 6 82 18 94 29 11 10 40 25 65 34 48 17 122 61 185 110 22 18 75 53 118 78 43 26 102 72 132 102 78 80 129 93 214 55 24 -11 57 -20 73 -20 52 0 201 -30 282 -56 61 -21 89 -25 127 -20 26 4 67 2 91 -4 50 -12 298 -29 588 -39 123 -5 222 -13 247 -22 37 -11 49 -11 90 4 61 21 535 27 572 7 26 -14 51 -67 51 -108 0 -16 7 -36 17 -43 9 -8 26 -36 38 -64 13 -27 32 -58 43 -69 12 -10 27 -35 33 -55 19 -58 55 -107 96 -132 47 -28 110 -80 171 -140 40 -40 54 -48 95 -52 26 -2 76 -18 110 -34 80 -38 175 -53 341 -53 l133 0 99 35 c54 19 115 35 135 35 21 0 47 9 62 20 34 27 101 50 146 50 24 0 49 9 71 25 18 13 49 30 69 36 43 14 107 52 162 96 21 17 56 37 77 44 20 6 75 37 122 67 46 31 105 64 131 73 26 10 68 31 94 48 25 16 70 35 98 41 29 7 59 19 67 26 31 26 94 46 159 48 43 1 75 8 93 20 77 51 473 54 606 6 20 -7 54 -10 82 -7 27 3 64 2 82 -4 18 -5 89 -12 158 -15 69 -3 138 -10 154 -15 16 -5 47 -9 70 -9 55 0 231 -62 264 -93 15 -13 51 -32 81 -42 29 -10 61 -25 71 -35 10 -10 32 -21 49 -25 17 -3 45 -16 63 -29 58 -38 179 -95 193 -89 19 7 138 -34 169 -58 13 -11 40 -19 60 -19 37 0 131 -33 156 -55 15 -13 55 -19 230 -34 52 -5 115 -16 140 -26 74 -29 158 -36 502 -41 l327 -5 30 22 c20 14 53 24 103 30 119 14 218 35 293 63 39 14 86 26 106 26 22 0 51 10 75 26 21 15 56 33 77 40 21 7 51 23 67 34 16 11 47 27 70 35 23 8 54 24 70 35 16 11 46 27 67 34 46 17 147 77 183 109 14 13 59 43 100 67 83 48 296 248 356 335 37 52 67 93 147 196 27 34 55 83 63 109 8 26 23 55 33 65 11 9 27 39 36 66 9 26 25 59 35 72 11 13 29 49 40 80 12 31 26 59 31 62 5 4 9 21 9 38 0 55 29 188 50 226 26 50 31 93 36 352 l5 226 -21 59 c-12 32 -26 91 -31 129 -18 138 -26 175 -41 192 -9 10 -26 42 -38 72 -11 30 -29 65 -40 78 -10 13 -24 41 -31 61 -6 20 -23 57 -38 82 -14 25 -33 57 -41 71 -35 61 -81 118 -176 218 -88 92 -103 112 -112 155 -6 27 -8 55 -5 62 3 8 -7 37 -21 66 -14 28 -26 69 -26 89 0 21 -5 50 -11 65 -5 16 -12 60 -14 98 -2 47 -10 84 -24 111 -12 21 -21 56 -21 77 0 26 -15 66 -45 124 -29 55 -45 98 -45 121 0 34 -76 209 -106 243 -7 9 -20 36 -29 60 -17 49 -66 131 -101 170 -12 14 -45 62 -72 108 -28 45 -63 97 -79 116 -15 19 -43 59 -61 90 -20 34 -46 63 -65 72 -18 9 -82 64 -144 123 -201 189 -236 218 -293 240 -34 13 -74 40 -110 74 -36 35 -70 58 -97 66 -23 6 -55 22 -70 35 -15 13 -51 31 -79 40 -29 9 -60 26 -69 36 -10 11 -23 20 -29 20 -6 0 -36 12 -66 27 -30 14 -61 25 -68 24 -21 -3 -124 29 -158 50 -17 10 -43 19 -56 19 -35 0 -138 37 -171 61 -23 17 -37 19 -76 14 -31 -4 -69 -1 -108 9 -107 28 -793 12 -844 -20 -15 -9 -112 -22 -294 -38 -92 -8 -164 -19 -187 -29 -21 -10 -57 -17 -80 -17 -24 0 -68 -7 -98 -15 -30 -8 -87 -15 -126 -15 -50 0 -85 -6 -117 -20 -25 -11 -65 -21 -89 -21 -23 -1 -68 -7 -99 -15 -31 -8 -85 -14 -120 -14 -44 0 -82 -8 -128 -26 -53 -22 -76 -25 -123 -21 -31 3 -74 0 -95 -5 -80 -21 -747 -49 -788 -32 -41 16 -90 70 -114 125 -12 26 -28 53 -38 60 -9 8 -27 39 -41 69 -45 102 -92 168 -142 199 -26 16 -57 43 -69 59 -12 18 -34 33 -53 37 -17 4 -51 25 -75 48 -50 46 -44 45 -281 53 l-163 6 -38 -27 c-25 -16 -63 -30 -107 -37 -38 -6 -85 -22 -104 -34 -19 -13 -50 -29 -68 -35 -89 -31 -179 -98 -316 -236 -169 -170 -222 -234 -239 -286 -9 -27 -29 -63 -45 -81 -16 -19 -43 -69 -61 -112 -18 -44 -36 -89 -41 -102 -24 -55 -123 -62 -230 -14 -39 17 -106 26 -315 43 -304 25 -547 10 -683 -40 -140 -52 -211 -36 -247 54 -11 28 -30 66 -42 85 -11 19 -26 54 -32 76 -6 23 -19 48 -28 55 -9 8 -25 34 -36 58 -10 24 -36 60 -56 80 -20 20 -49 60 -66 89 -45 79 -63 101 -104 122 -21 10 -44 26 -51 35 -8 9 -34 27 -59 40 -25 13 -66 44 -90 69 -29 29 -62 51 -92 61 -26 9 -60 25 -74 37 -16 12 -50 23 -89 28 -62 8 -88 17 -136 51 -26 18 -211 29 -354 21z",
    outMain: "M3975 7030 c-16 -5 -39 -7 -51 -4 -13 3 -46 -8 -88 -30 -37 -20 -74 -36 -81 -36 -8 0 -23 -13 -34 -29 -12 -16 -43 -43 -69 -59 -69 -43 -140 -117 -153 -162 -7 -21 -29 -56 -50 -76 -32 -32 -39 -45 -39 -78 0 -34 -6 -45 -49 -85 -52 -49 -71 -78 -71 -109 0 -11 -13 -36 -30 -57 -16 -21 -35 -56 -41 -79 -6 -22 -19 -50 -29 -61 -25 -27 -73 -154 -65 -173 3 -9 -10 -48 -30 -87 -20 -39 -40 -95 -44 -125 -5 -30 -18 -73 -30 -95 -11 -21 -21 -54 -21 -72 0 -18 -12 -66 -26 -106 -27 -75 -49 -182 -63 -302 -4 -39 -14 -82 -21 -95 -8 -14 -20 -95 -27 -180 -20 -229 -27 -281 -46 -324 -10 -22 -17 -65 -17 -100 0 -33 -7 -88 -15 -121 -8 -34 -14 -110 -15 -173 0 -69 -5 -122 -12 -135 -42 -76 -47 -699 -7 -852 13 -50 25 -138 38 -278 7 -75 16 -121 30 -148 33 -63 20 -90 -48 -103 -18 -3 -51 -22 -72 -41 -22 -19 -45 -35 -52 -35 -75 -1 -474 -367 -496 -455 -6 -24 -21 -56 -34 -72 -29 -34 -66 -145 -65 -194 0 -20 -10 -55 -22 -79 -24 -46 -24 -37 0 -200 12 -79 57 -219 84 -260 13 -19 33 -51 44 -70 12 -19 72 -85 134 -147 l113 -112 90 -36 c144 -58 186 -65 420 -65 147 0 231 5 280 15 38 8 83 15 98 15 16 0 41 8 55 19 16 11 53 20 91 24 50 4 73 12 108 37 34 25 60 34 113 41 46 5 82 17 107 33 21 14 53 31 72 37 41 15 157 83 191 114 14 12 61 43 105 70 44 26 110 76 147 111 74 72 94 77 198 49 30 -8 73 -15 95 -15 22 0 62 -9 90 -19 65 -25 165 -42 290 -50 55 -3 106 -10 114 -15 7 -5 34 -10 60 -12 250 -19 331 -22 494 -23 139 -1 203 -5 242 -17 l54 -15 52 15 c42 13 106 16 304 16 l252 0 20 -22 c12 -14 23 -42 26 -70 3 -31 14 -61 31 -83 15 -19 32 -50 38 -68 6 -17 23 -45 37 -62 15 -16 43 -61 62 -99 23 -47 44 -75 63 -85 16 -9 46 -31 66 -49 21 -17 41 -32 45 -32 5 0 32 -23 61 -50 43 -41 58 -49 78 -44 16 4 39 -2 68 -19 54 -31 144 -61 163 -53 8 3 30 -1 49 -9 57 -24 338 -21 394 5 23 10 79 24 125 30 59 8 94 19 127 40 28 17 66 30 100 34 71 9 301 121 370 181 14 12 44 27 67 34 23 6 55 22 70 35 44 36 159 106 175 106 8 0 36 14 63 31 27 17 85 44 129 61 45 16 104 38 131 49 28 10 72 18 99 19 36 0 60 7 85 24 l36 25 155 6 c91 4 202 1 270 -5 63 -6 158 -15 210 -18 52 -4 101 -11 109 -16 16 -11 127 -24 266 -31 170 -9 271 -39 343 -101 21 -18 58 -37 83 -44 24 -6 55 -22 69 -35 14 -12 48 -30 77 -39 28 -10 57 -23 63 -31 18 -21 136 -65 177 -65 20 0 44 -6 52 -14 26 -23 119 -56 158 -56 20 0 44 -6 52 -14 26 -24 123 -56 167 -56 23 0 63 -9 89 -21 29 -13 85 -24 148 -30 156 -14 239 -26 275 -39 19 -7 56 -10 84 -8 29 3 75 -1 106 -9 107 -28 447 -6 512 33 26 16 58 23 125 27 63 4 109 13 153 30 34 14 104 32 156 41 66 10 104 22 131 40 20 14 51 30 69 34 17 5 48 21 69 35 21 14 54 31 74 38 20 6 57 25 82 40 25 16 51 29 59 29 17 0 121 62 177 106 22 17 76 53 120 80 55 34 114 85 196 169 165 170 176 184 284 342 19 28 39 54 44 58 5 3 17 29 25 58 9 30 25 62 36 72 11 10 27 41 35 69 8 27 24 59 34 70 26 28 61 123 61 166 0 32 10 68 61 220 10 30 16 65 13 76 -3 12 2 38 10 59 13 30 16 80 16 264 l0 226 -21 45 c-15 32 -24 78 -29 158 -6 87 -13 120 -29 145 -22 35 -30 50 -60 117 -11 25 -27 56 -35 70 -8 14 -24 45 -36 70 -11 25 -27 56 -35 70 -8 14 -22 41 -30 60 -27 61 -82 131 -179 230 -100 100 -116 126 -116 192 0 25 -8 51 -22 71 -17 24 -25 53 -30 112 -16 181 -24 224 -43 245 -13 15 -21 43 -26 89 -4 52 -13 78 -36 112 -21 31 -33 64 -40 114 -8 49 -20 86 -42 120 -17 27 -31 56 -31 64 0 9 -14 36 -30 61 -16 25 -35 61 -41 80 -14 41 -52 106 -94 159 -17 21 -51 71 -75 112 -24 41 -58 92 -75 114 -17 22 -48 68 -69 102 -21 35 -46 65 -59 69 -12 4 -72 56 -133 115 -62 60 -116 109 -120 109 -5 0 -39 29 -76 64 -50 47 -79 66 -113 75 -32 8 -61 26 -98 62 -54 53 -84 72 -129 83 -14 3 -39 17 -55 30 -15 12 -51 31 -79 40 -29 9 -59 25 -68 35 -21 23 -142 65 -163 57 -9 -4 -32 3 -51 15 -53 31 -133 59 -169 59 -17 0 -49 10 -70 22 -68 41 -123 55 -191 50 -49 -3 -73 0 -113 17 l-51 22 -231 -6 c-128 -3 -262 -5 -299 -5 -36 0 -79 -5 -95 -11 -36 -14 -123 -27 -308 -45 -241 -23 -288 -30 -327 -47 -22 -10 -63 -17 -100 -17 -35 0 -90 -7 -123 -15 -33 -8 -80 -15 -105 -15 -25 0 -65 -9 -89 -20 -25 -12 -65 -20 -95 -20 -28 0 -78 -5 -111 -11 -33 -6 -89 -14 -125 -18 -36 -5 -79 -15 -95 -23 -20 -10 -75 -17 -160 -21 -71 -3 -146 -11 -165 -17 -19 -5 -85 -10 -146 -10 -77 0 -123 -5 -147 -15 -28 -11 -78 -15 -209 -15 l-172 0 -49 53 c-27 28 -58 72 -68 96 -11 24 -33 59 -48 77 -16 18 -33 43 -37 56 -13 42 -88 160 -113 177 -13 9 -44 35 -70 58 -26 23 -60 45 -76 48 -17 4 -48 25 -70 45 -46 44 -53 45 -305 59 l-155 9 -39 -25 c-24 -16 -62 -28 -101 -33 -60 -7 -94 -19 -125 -45 -8 -6 -35 -19 -60 -28 -25 -10 -70 -34 -101 -55 -31 -20 -76 -50 -100 -67 -59 -39 -197 -173 -216 -209 -8 -16 -43 -59 -78 -96 -43 -46 -64 -77 -69 -103 -4 -20 -22 -54 -41 -77 -19 -23 -37 -58 -41 -78 -4 -20 -12 -44 -19 -52 -7 -8 -24 -40 -38 -71 -31 -71 -33 -71 -158 -43 -57 13 -126 23 -152 24 -28 0 -65 9 -90 21 l-42 22 -315 1 -315 1 -95 -34 c-173 -61 -263 -50 -290 36 -7 21 -23 56 -37 77 -14 22 -28 58 -30 80 -4 28 -16 52 -38 76 -18 19 -35 47 -39 62 -3 15 -22 42 -41 59 -19 18 -55 64 -79 103 -47 75 -148 166 -215 193 -20 8 -58 37 -86 63 -55 54 -145 96 -279 131 -43 11 -90 28 -104 37 -18 12 -58 19 -127 24 -55 3 -118 9 -140 12 -22 3 -53 1 -70 -4z m203 -389 c23 -5 59 -20 80 -34 20 -14 55 -30 78 -36 22 -6 49 -20 59 -31 10 -11 41 -27 68 -35 48 -14 106 -60 227 -179 72 -70 149 -185 176 -259 7 -21 23 -52 36 -69 12 -17 25 -53 29 -80 6 -37 25 -75 74 -148 79 -117 76 -115 140 -125 106 -18 356 3 388 32 37 35 63 43 130 43 35 0 86 7 113 15 63 19 214 19 277 0 29 -9 88 -14 145 -14 107 0 164 -10 234 -41 26 -11 83 -25 128 -31 45 -5 115 -23 156 -39 94 -38 116 -37 184 3 43 26 58 42 70 74 9 23 25 52 37 65 23 25 53 119 53 166 0 16 9 41 20 55 11 14 27 45 36 69 8 23 23 52 33 63 10 11 42 59 70 106 64 107 216 254 306 295 22 10 53 29 68 41 15 12 44 25 65 28 20 3 67 21 103 40 59 31 76 35 140 35 78 0 83 -2 170 -68 68 -52 219 -260 219 -302 0 -9 11 -31 25 -50 14 -19 34 -59 46 -89 11 -31 26 -63 34 -71 30 -35 55 -101 55 -148 0 -35 6 -57 24 -80 16 -22 26 -53 30 -96 5 -45 16 -75 37 -107 16 -24 29 -48 29 -54 0 -5 14 -38 32 -72 47 -93 117 -120 218 -85 l55 19 37 74 c44 86 47 121 13 171 -14 21 -29 62 -35 102 -6 36 -15 78 -21 93 -26 70 24 105 150 103 121 -2 513 19 545 30 16 6 46 10 67 10 20 0 61 9 91 20 35 13 102 23 198 30 214 16 242 20 275 44 25 18 50 22 155 28 190 10 241 18 273 42 24 18 49 22 150 28 141 7 259 22 278 34 51 32 643 56 794 33 39 -6 91 -12 117 -14 28 -2 60 -12 77 -24 42 -30 106 -51 156 -51 29 0 47 -6 59 -19 23 -26 99 -51 151 -51 29 0 47 -6 60 -20 10 -11 42 -27 71 -36 41 -12 63 -26 96 -63 46 -51 93 -81 127 -81 11 0 32 -11 47 -25 15 -14 51 -32 80 -42 48 -15 70 -34 221 -188 92 -94 178 -186 190 -205 53 -83 92 -136 112 -154 11 -11 21 -27 21 -37 0 -9 16 -36 35 -59 19 -23 35 -48 35 -55 0 -7 15 -33 33 -57 89 -121 100 -140 104 -192 6 -77 10 -90 41 -129 24 -29 31 -51 36 -107 6 -55 13 -77 34 -102 24 -28 28 -43 34 -127 4 -68 14 -116 34 -166 16 -42 30 -102 34 -150 5 -65 12 -89 38 -129 17 -27 37 -65 43 -84 21 -62 42 -90 214 -280 41 -46 75 -89 75 -96 0 -7 9 -21 20 -31 11 -10 28 -41 39 -70 11 -29 31 -69 45 -89 15 -23 27 -58 31 -94 4 -31 20 -90 36 -130 l29 -74 0 -240 0 -241 -41 -121 c-23 -67 -42 -142 -44 -168 -1 -29 -10 -57 -24 -74 -11 -14 -26 -45 -32 -67 -7 -25 -27 -56 -54 -83 -40 -38 -43 -46 -38 -77 4 -29 1 -40 -20 -59 -95 -88 -151 -145 -171 -174 -12 -18 -35 -43 -49 -55 -15 -11 -37 -39 -48 -61 -11 -22 -34 -47 -51 -56 -17 -9 -63 -46 -102 -81 -80 -72 -192 -147 -251 -169 -22 -9 -55 -26 -73 -40 -20 -14 -55 -27 -87 -31 -32 -5 -66 -17 -87 -32 -18 -14 -59 -31 -91 -38 -33 -7 -71 -24 -89 -39 -28 -24 -43 -28 -127 -33 -72 -5 -115 -14 -171 -37 l-76 -30 -154 -7 c-89 -4 -249 -2 -375 5 l-220 11 -55 25 c-35 16 -80 27 -123 30 -38 2 -77 9 -87 14 -10 6 -35 10 -55 10 -24 0 -47 8 -65 24 -21 17 -46 25 -96 30 -51 5 -77 14 -102 33 -25 18 -53 28 -108 34 -58 8 -85 17 -115 39 -22 16 -55 32 -72 35 -18 4 -43 17 -57 30 -14 12 -48 30 -75 39 -36 12 -67 32 -105 72 -41 41 -68 59 -106 70 -68 20 -378 315 -395 376 -5 21 -28 58 -49 84 -22 25 -40 53 -40 63 0 9 -11 32 -25 51 -13 18 -30 49 -36 69 -7 20 -24 54 -40 76 -19 28 -29 58 -34 102 -5 45 -15 75 -37 109 l-31 46 7 141 6 141 27 34 c43 56 160 172 174 172 8 0 39 16 71 35 62 39 166 55 260 41 71 -11 251 -159 279 -230 7 -17 21 -44 32 -59 10 -15 27 -51 38 -79 10 -28 28 -61 39 -73 14 -15 24 -45 30 -85 5 -34 10 -64 12 -65 171 -182 255 -257 304 -271 28 -8 60 -24 69 -34 10 -11 41 -27 69 -35 27 -8 59 -24 71 -35 26 -25 127 -60 172 -60 19 0 47 -10 63 -22 18 -13 55 -25 92 -30 35 -5 90 -13 123 -17 33 -5 87 -18 119 -30 l60 -22 195 5 c236 6 312 15 341 41 15 13 43 21 91 26 55 5 79 12 112 36 29 21 59 32 96 36 40 5 62 14 82 33 29 28 70 54 150 98 57 31 166 157 175 202 3 18 22 48 45 70 34 34 39 44 39 85 0 31 8 61 21 84 17 28 23 59 27 129 6 118 -11 180 -84 303 l-55 92 -50 16 -50 17 -61 -18 c-48 -15 -66 -26 -85 -54 -13 -19 -35 -50 -48 -69 -37 -50 -34 -65 21 -150 24 -36 37 -137 25 -193 -13 -58 -185 -258 -222 -258 -9 0 -34 -12 -55 -27 -92 -62 -309 -127 -419 -125 -135 3 -262 12 -312 22 -32 7 -83 10 -114 6 -48 -5 -61 -2 -84 15 -37 30 -118 59 -164 59 -23 0 -48 8 -64 21 -15 11 -46 27 -71 35 -24 8 -52 24 -62 35 -10 11 -41 26 -70 35 -72 21 -150 114 -189 225 -9 24 -22 51 -31 60 -8 9 -24 40 -35 69 -11 29 -31 67 -44 85 -15 18 -25 45 -25 64 0 50 -20 78 -127 182 -67 66 -110 99 -131 104 -18 4 -45 17 -60 30 -15 12 -47 29 -72 36 -25 7 -56 20 -70 28 -19 13 -64 17 -218 19 l-194 4 -36 -25 c-25 -16 -59 -26 -102 -30 -42 -5 -76 -15 -100 -31 -19 -13 -51 -33 -71 -44 -33 -20 -76 -64 -171 -175 -20 -23 -40 -56 -44 -72 -4 -17 -17 -43 -30 -58 -29 -35 -66 -151 -58 -182 3 -12 -1 -36 -9 -51 -11 -21 -16 -72 -18 -179 l-4 -150 23 -31 c16 -21 26 -53 32 -98 6 -47 16 -79 35 -106 18 -26 29 -59 35 -103 9 -71 48 -146 140 -267 79 -104 89 -147 44 -195 -30 -33 -79 -32 -156 4 -56 25 -231 32 -283 12 -20 -8 -77 -11 -170 -9 l-140 3 -29 -22 c-16 -13 -41 -23 -56 -23 -15 0 -49 -7 -76 -15 -27 -8 -66 -15 -87 -15 -22 0 -51 -8 -65 -18 -15 -11 -42 -24 -60 -30 -18 -6 -45 -20 -61 -31 -15 -11 -49 -28 -77 -39 -27 -10 -67 -31 -88 -45 -21 -15 -47 -27 -56 -27 -9 0 -35 -12 -56 -26 -21 -15 -56 -33 -78 -41 -22 -7 -61 -27 -86 -43 -26 -17 -53 -30 -60 -30 -16 0 -111 -53 -178 -101 -36 -25 -69 -39 -102 -44 -27 -4 -60 -15 -72 -25 -47 -36 -108 -60 -153 -60 -34 0 -55 -7 -79 -25 l-33 -25 -165 0 -165 0 -44 30 c-24 16 -61 35 -83 41 -106 29 -297 312 -299 444 0 45 40 134 81 178 15 15 33 47 42 69 10 29 29 52 60 74 25 18 65 50 90 72 25 22 70 52 100 66 30 14 62 30 70 35 8 5 33 18 55 29 22 10 58 28 80 40 22 12 60 30 85 41 25 12 59 32 75 45 l30 24 -2 75 c-1 86 -10 106 -59 143 -72 55 -242 42 -343 -26 -28 -19 -57 -30 -78 -30 -36 0 -103 -26 -103 -40 0 -4 -44 -34 -97 -66 -140 -85 -327 -272 -355 -355 -21 -62 -63 -108 -101 -110 -95 -5 -125 -9 -147 -17 -14 -5 -101 -7 -194 -5 l-168 4 -63 -22 -62 -23 -54 21 -54 21 -161 -6 c-111 -3 -172 -1 -195 7 -19 6 -106 14 -194 17 -88 2 -176 9 -195 14 -19 6 -54 10 -78 10 -24 0 -61 9 -84 21 -23 12 -76 25 -122 30 -171 19 -214 27 -242 42 -36 20 -144 47 -189 47 -19 0 -37 5 -41 11 -13 21 -109 59 -152 59 -28 0 -55 8 -80 24 -20 13 -53 29 -73 35 -19 6 -53 29 -74 51 -33 34 -45 40 -80 40 -35 0 -46 6 -91 52 -76 80 -151 136 -195 148 -35 10 -46 21 -89 88 -27 42 -76 109 -109 147 -81 93 -85 101 -100 165 -6 30 -24 74 -40 97 -18 27 -30 61 -34 96 -4 30 -16 76 -28 102 -12 26 -22 64 -24 84 -2 20 -8 90 -14 156 -13 149 -13 472 1 665 5 80 11 183 12 230 2 62 9 97 24 130 14 28 22 65 22 100 0 30 7 86 15 125 8 38 15 105 15 148 0 60 5 87 22 120 17 34 22 68 28 187 6 122 12 156 34 215 26 68 41 138 54 265 5 42 15 76 29 95 25 34 57 140 48 155 -4 6 4 27 17 48 34 54 66 135 93 236 20 75 31 97 65 131 33 33 40 48 40 79 0 34 7 44 54 88 44 40 57 59 66 98 6 27 20 56 31 66 11 10 29 33 40 51 66 106 208 161 347 134z m-1134 -4292 c14 -11 33 -33 40 -47 8 -15 87 -99 175 -187 148 -146 198 -187 301 -244 19 -10 44 -28 54 -40 11 -12 38 -26 60 -32 23 -6 61 -24 85 -40 25 -16 52 -29 62 -29 33 0 73 -44 66 -72 -7 -27 -108 -93 -175 -116 -19 -7 -49 -25 -67 -40 -19 -17 -50 -32 -74 -36 -24 -3 -54 -15 -69 -26 -47 -34 -202 -91 -296 -108 -110 -21 -380 -22 -476 -4 -110 22 -220 100 -248 175 -12 30 -32 70 -45 90 -49 72 -47 231 4 304 16 23 29 46 29 51 0 6 17 32 38 59 20 26 45 60 55 76 10 15 37 41 60 57 23 16 49 36 57 43 8 8 33 26 55 39 22 14 47 33 55 43 8 9 37 28 65 42 27 13 66 33 85 43 45 25 71 25 104 -1z",
    eyeL: "M5070 3576 c-84 -53 -148 -97 -196 -138 -90 -76 -244 -86 -327 -23 -25 19 -54 35 -65 35 -27 0 -108 57 -138 96 -50 65 -147 72 -236 17 -68 -42 -74 -51 -84 -121 l-6 -51 42 -66 c60 -96 203 -232 258 -246 23 -6 58 -24 77 -39 l34 -27 118 -7 c65 -3 177 -2 249 2 l131 9 64 38 c35 21 93 67 129 101 36 35 77 68 93 73 15 6 32 23 38 38 6 16 25 43 42 61 28 29 32 39 31 90 -1 78 -10 109 -34 117 -11 3 -38 22 -61 41 -53 44 -88 44 -159 0z",
    eyeR: "M7335 3567 c-73 -43 -101 -64 -180 -129 -75 -61 -228 -86 -297 -48 -18 10 -64 34 -103 53 -39 19 -93 56 -121 85 -41 40 -62 52 -106 62 l-55 13 -67 -38 c-75 -42 -82 -51 -91 -121 -9 -68 26 -127 153 -256 80 -81 102 -98 141 -108 25 -6 59 -23 74 -38 l28 -27 202 -7 c111 -4 225 -4 252 -1 64 7 157 63 242 143 35 33 74 66 88 72 14 6 36 31 50 55 14 23 30 43 34 43 17 0 34 62 32 117 -1 76 -6 88 -44 112 -18 12 -45 30 -62 41 -47 31 -91 25 -170 -23z",
    nose: "M5730 2681 c-118 -6 -140 -13 -176 -53 -49 -53 -39 -108 29 -155 l40 -28 131 -3 c174 -5 196 2 236 76 30 56 34 102 8 102 -6 0 -32 13 -57 29 -58 37 -70 39 -211 32z",
  };
  // shared trace transform (potrace y-flip) — maps the path data into the 1744x720 frame
  const TT = 'transform="translate(0,720) scale(0.1,-0.1)"';


  /* ---- MASTIFF paths (TRACED — potrace, source frame 2360x1120) ----
     Rob's Spanish mastiff "Senda": heavy curled body, head resting LEFT, long droopy
     ears, jowly muzzle, front paws stretched forward (sploot). The SILHOUETTE is traced
     from her real photo (reference/senda-1.png, flipped head-left) via the same
     potrace pipeline that built the cat/dog — pre-smooth → clean guide-mask → potrace —
     so the body line is the loose organic doodle, not regularised geometry. It lives in
     the potrace y-flipped frame (MTT below). Unlike the recolourable cat/dog, the mastiff
     is a fixed "Senda" look: fawn body, black mask over the muzzle, black droopy ears, a
     darker saddle. The dark regions (mask/ears/saddle/belly) have no hard threshold edge
     in the photo (matching terracotta floor, soft fur), so — exactly as the cat's belly/
     inner-ears/blush are positioned shapes — they're authored UPRIGHT in the same 2360x1120
     frame (no y-flip) and clipped to the traced silhouette:
       sil     = body+head silhouette (fur) — TRACED, drawn under MTT
       earFar  = the far ear, a dark lobe draping the right of the head (clipped)
       earNear = the long droopy near ear hanging down the left, in front of the cheek
       mask    = the black muzzle mask (clipped); saddle = darker back (clipped);
       belly   = lighter chest/underside (clipped); eyeClosed = sleepy arc;
       nose = blunt nose; eyeOpen / cheek = positioned. */
  const MASTIFF_P = {
    sil: "M4685 10228 c-480 -71 -957 -286 -1420 -638 -163 -123 -214 -168 -393 -345 -235 -230 -344 -362 -534 -650 -264 -400 -374 -645 -447 -1003 -16 -77 -14 -334 3 -412 85 -388 357 -654 821 -805 61 -19 124 -40 141 -45 17 -6 40 -10 51 -10 25 0 73 -36 73 -56 0 -8 20 -58 45 -111 235 -502 774 -866 1500 -1011 94 -19 142 -27 338 -52 105 -14 647 -13 741 1 98 15 123 8 131 -33 28 -148 84 -345 195 -678 134 -404 190 -593 180 -604 -3 -2 -84 22 -180 54 -202 68 -437 130 -605 159 -155 26 -186 31 -275 41 -460 50 -823 37 -1180 -41 -109 -25 -142 -34 -255 -71 -611 -201 -963 -642 -855 -1073 95 -378 475 -666 1105 -835 529 -143 1280 -214 1924 -181 506 25 964 81 1321 162 25 6 63 14 85 19 142 31 384 95 460 122 l31 10 64 -42 c134 -87 392 -199 555 -241 17 -4 55 -14 85 -22 30 -8 84 -20 120 -26 36 -7 85 -16 110 -21 55 -10 160 -25 300 -41 139 -17 737 -17 890 0 328 35 499 60 699 103 l55 12 30 -39 c345 -444 985 -770 1876 -955 30 -7 73 -16 95 -20 72 -15 247 -44 360 -60 44 -6 107 -15 140 -20 1406 -204 3973 -227 5540 -48 139 16 271 16 405 -1 931 -112 2009 -100 2595 29 22 5 65 14 95 21 404 88 736 249 880 428 75 93 136 205 171 313 l33 103 -1 130 c-1 294 -139 539 -410 731 -51 37 -93 69 -93 73 0 4 31 25 69 45 248 137 448 361 549 616 27 67 40 114 72 257 13 57 13 378 -1 445 -43 215 -87 354 -155 490 -95 190 -190 315 -374 498 -456 452 -1161 813 -2165 1110 -88 26 -384 101 -470 120 -33 7 -73 16 -90 20 -16 4 -57 13 -90 20 -33 6 -78 15 -100 20 -22 5 -69 14 -105 20 -36 6 -85 15 -110 20 -25 5 -79 13 -120 20 -41 6 -100 15 -130 20 -106 17 -309 43 -470 59 -1048 108 -2158 90 -4150 -69 -191 -15 -737 -39 -900 -40 -276 0 -1035 -41 -1325 -71 -671 -69 -973 -174 -1044 -363 -102 -274 -623 -607 -1261 -808 -112 -35 -115 -36 -290 -81 -257 -65 -384 -87 -710 -127 -103 -12 -237 -13 -244 -1 -3 4 60 65 139 136 437 386 737 852 895 1395 12 41 26 86 31 100 16 46 79 291 98 385 65 310 91 530 91 774 0 162 -5 223 -31 381 -71 425 -285 710 -639 850 -208 83 -380 131 -565 159 -38 6 -100 15 -136 21 -85 13 -513 13 -598 0 -149 -23 -200 -32 -281 -52 -193 -46 -383 -124 -520 -212 -40 -26 -79 -46 -87 -44 -9 2 -30 48 -53 113 -223 644 -676 1118 -1270 1333 -168 61 -280 86 -527 122 -86 12 -443 11 -528 -2z",
    // upright overlays (2360x1120 frame, no y-flip)
    earFar:  "M 760 240 C 950 230 1010 380 970 540 C 900 560 820 520 790 420 C 765 340 750 290 760 240 Z",
    earNear: "M 300 150 C 252 176 230 290 240 426 C 247 552 292 628 358 614 C 424 598 438 466 424 340 C 414 252 396 186 358 160 C 338 147 318 143 300 150 Z",
    mask:    "M 130 410 C 120 340 175 295 295 295 C 440 295 515 350 508 432 C 500 505 415 545 300 540 C 200 535 140 478 130 410 Z",
    saddle:  "M 700 300 C 1100 250 1700 270 2150 360 C 2250 520 2200 640 2050 700 C 1500 720 1000 700 760 600 C 680 460 660 380 700 300 Z",
    belly:   "M 700 820 C 1100 920 1800 920 2200 840 C 2240 960 2000 1010 1600 1010 C 1000 1010 760 940 700 860 Z",
    eyeClosed: "M 515 280 C 555 254 620 254 658 282",
    nose:    { cx: 160, cy: 392, rx: 74, ry: 58 },
    eyeOpen: { cx: 586, cy: 268, rx: 50, ry: 60, hl: 20 },
    cheek:   { cx: 640, cy: 500, rx: 95, ry: 54 },
  };
  // mastiff trace transform (potrace y-flip) — maps the SILHOUETTE into the 2360x1120 frame
  const MTT = 'transform="translate(0,1120) scale(0.1,-0.1)"';

  /* ---- palette: per-colour fills (real-art anchored) ----
     fur   = the main body (recolours the traced silhouette)
     dark  = inner-ears / haunch stripes / brow-heart (a deeper shade of fur)
     belly = the soft lighter chest/muzzle patch
     cheek = the blush                                              */
  const PALETTE = [
    { name: "Blossom",  fur: "#F9D6EE", dark: "#EF9BDA", belly: "#FEF5FB", cheek: "#EE7FC0" }, // pink (default)
    { name: "Sunset",   fur: "#E79A41", dark: "#CE7E2A", belly: "#F6D7AE", cheek: "#E8632F" }, // orange (corgi anchor)
    { name: "Ink",      fur: "#4F4A57", dark: "#6B6575", belly: "#827C8C", cheek: "#EE7FC0" }, // black (warm grey)
    { name: "Sunbeam",  fur: "#F1D86D", dark: "#E0C047", belly: "#FBF1C4", cheek: "#EFA84E" }, // yellow
    { name: "Meadow",   fur: "#A9C173", dark: "#8BA653", belly: "#E0EAC6", cheek: "#D88BC0" }, // olive
    { name: "Sky",      fur: "#A6CADC", dark: "#82B0C8", belly: "#DCEDF4", cheek: "#EE7FC0" }, // blue
    { name: "Iris",     fur: "#C39AE0", dark: "#A87BCC", belly: "#EBDDF6", cheek: "#E07BC4" }, // purple
    { name: "Bubblegum",fur: "#E797D2", dark: "#D070B8", belly: "#F8E0F1", cheek: "#E0588F" }, // magenta
    { name: "Pebble",   fur: "#B7B7B7", dark: "#999999", belly: "#E2E2E2", cheek: "#EE9CBE" }, // gray
    // Ginger-&-white bicolor, modelled on Rob's cat: white fur + ginger patches,
    // tabby ticks on the orange, pink nose. swatch shows the two tones.
    { name: "Ginger & white", fur: "#F7F2EA", dark: "#E3DCCF", belly: "#FFFFFF", cheek: "#EFA59B",
      pattern: "bicolor", patch: "#E89A4E", patchDark: "#CB7A2C", noseFill: "#E98DA1",
      swatch: "linear-gradient(135deg,#F7F2EA 0 47%,#E89A4E 53% 100%)" },
    // Brown-grey mackerel tabby, modelled on Rob's cat Pruna: warm grey-brown base,
    // darker mackerel stripes, cream belly/chest, tabby forehead "M", dark tail rings,
    // pinkish nose. Cat-only pattern (like the bicolor). swatch = base + a stripe band.
    { name: "Pruna", fur: "#9C8C76", dark: "#4A4038", belly: "#D9CDB6", cheek: "#C9A6A0",
      pattern: "tabby", stripe: "#4A4038", noseFill: "#D98A8A",
      swatch: "linear-gradient(135deg,#9C8C76 0 38%,#4A4038 44% 56%,#9C8C76 62% 100%)" },
    // Fawn Spanish-mastiff look, modelled on Rob's dog Senda: fawn body, darker saddle,
    // black mask + droopy ears. A fixed mastiff-only colour (the mastiff ignores the
    // recolour palette and always uses this). swatch = fawn with a black mask band.
    { name: "Senda", fur: "#C9A05A", dark: "#8A6A3A", belly: "#E2C68C", cheek: "#C98B7E",
      saddle: "#8A6A3A", mask: "#2E2620", ear: "#241d29", noseFill: "#1E1812",
      species: "mastiff",
      swatch: "linear-gradient(135deg,#2E2620 0 30%,#C9A05A 38% 100%)" },
  ];

  /* ---- hats (optional, selectable). Drawn in the 1744x720 trace frame, sitting
     on the cat's head (the head is low-left in the resting pose). All are loose
     doodles matching the real Piti hat set; outline = OUT, stroke chunky. */
  const HATS = [
    { id: "none",   label: "None" },
    { id: "sprout", label: "Sprout" },
    { id: "tophat", label: "Top hat" },
    { id: "wizard", label: "Wizard" },
    { id: "beanie", label: "Beanie" },
    { id: "party",  label: "Party" },
  ];
  // Per-species hat transform. Hats are authored around centre x430 / brim ~y250,
  // then shifted onto the real crown:
  //  • CAT (1744x720 frame): ear-tips ~x380 & ~x690, dip ~y150  → translate(140,-82)
  // Hats sit bigger now (~1.3×), scaled about the brim-centre (430,250) so they grow
  // up/out while staying seated on the crown. translate = crownPoint − 430*s , −··· − 250*s.
  const HAT_T_CAT = 'transform="translate(11,-157) scale(1.3)"';   // cat crown (570,168)
  // mastiff TRACED frame 2360x1120; the visible head crown (top, between the ears)
  // sits at ~(560,115) measured off a coordinate-grid render. Hats authored around
  // (430,250) scaled 1.5 to the big head. translate = crown − 430*s , − 250*s.
  const HAT_T_MASTIFF = 'transform="translate(-85,-260) scale(1.5)"'; // mastiff crown (560,115)
  function hatSVG(id, species) {
    if (!id || id === "none") return "";
    const S = 'stroke="' + OUT + '" stroke-width="28" stroke-linejoin="round" stroke-linecap="round"';
    const HAT_T = species === "mastiff" ? HAT_T_MASTIFF : HAT_T_CAT;
    let inner = "";
    if (id === "sprout") {
      // a hand-drawn seedling — two leaves + stem on the crown (traced from the snail pal)
      inner = '<g ' + S + '>' +
        '<path d="M430 262 C 424 224 426 196 432 176" fill="none" stroke="#3C7E34" stroke-width="22"/>' +
        '<path d="M432 198 C 470 184 500 150 502 108 C 462 124 436 158 430 196 Z" fill="#62B852"/>' +
        '<path d="M430 214 C 396 198 364 170 360 132 C 398 150 424 182 432 214 Z" fill="#62B852"/>' +
        '</g>' +
        '<path d="M444 176 C 470 158 488 132 494 116" fill="none" stroke="#3C7E34" stroke-width="9"/>' +
        '<path d="M420 196 C 396 178 378 156 368 140" fill="none" stroke="#3C7E34" stroke-width="9"/>';
    } else if (id === "tophat") {
      inner = '<g ' + S + '>' +
        '<path d="M236 250 Q236 232 430 228 Q624 232 624 250 Q624 270 430 274 Q236 270 236 250 Z" fill="#2A2730"/>' +
        '<path d="M300 250 Q296 120 312 48 Q430 22 548 50 Q564 122 560 250 Q430 266 300 250 Z" fill="#2A2730"/>' +
        '<rect x="302" y="138" width="258" height="50" rx="8" fill="#D24A3F" stroke="none"/>' +
        '</g>';
    } else if (id === "wizard") {
      inner = '<g ' + S + '>' +
        '<path d="M236 258 Q236 238 430 234 Q624 238 624 258 Q624 278 430 282 Q236 278 236 258 Z" fill="#6E4FAE"/>' +
        '<path d="M430 14 Q510 140 572 252 Q430 268 288 252 Q350 140 430 14 Z" fill="#7B5CC0"/>' +
        '<path d="M404 104 l16 32 34 6 -25 24 6 35 -31 -17 -31 17 6 -35 -25 -24 34 -6z" fill="#F1D86D" stroke="none"/>' +
        '</g>';
    } else if (id === "beanie") {
      inner = '<g ' + S + '>' +
        '<path d="M278 222 Q286 86 430 82 Q574 86 582 222 Q430 238 278 222 Z" fill="#C0504A"/>' +
        '<path d="M252 256 Q252 208 430 204 Q608 208 608 256 Q608 284 430 286 Q252 284 252 256 Z" fill="#E8E2DA"/>' +
        '<circle cx="430" cy="64" r="30" fill="#E8E2DA"/>' +
        '</g>';
    } else if (id === "party") {
      inner = '<g ' + S + '>' +
        '<path d="M430 8 Q516 150 574 256 Q430 272 286 256 Q344 150 430 8 Z" fill="#C36ED0"/>' +
        '<path d="M384 118 q46 14 92 0 M360 178 q70 18 140 0" fill="none" stroke="#F1D86D" stroke-width="22"/>' +
        '<circle cx="430" cy="10" r="28" fill="#F1D86D"/>' +
        '</g>';
    } else { return ""; }
    return '<g ' + HAT_T + '>' + inner + '</g>';
  }

  /* ---- body markings, drawn inside the silhouette clip (1744x720 frame) ---- */
  // Default markings: soft belly, dark inner-ears, haunch stripes, heart brow, blush.
  function normalMarks(c) {
    return (
      '<ellipse cx="430" cy="500" rx="180" ry="120" fill="' + c.belly + '" opacity=".6"/>' +
      '<path d="M298 150 Q345 35 425 110 Q360 130 320 175 Z" fill="' + c.dark + '"/>' +
      '<path d="M548 150 Q600 35 660 122 Q600 130 565 170 Z" fill="' + c.dark + '"/>' +
      '<g fill="none" stroke="' + c.dark + '" stroke-width="30" stroke-linecap="round" opacity=".85">' +
        '<path d="M1070 460 Q1035 530 1070 600"/>' +
        '<path d="M1145 450 Q1110 525 1145 595"/>' +
        '<path d="M1218 462 Q1188 525 1218 590"/>' +
      '</g>' +
      '<path transform="translate(516,205) scale(6.2)" d="M0 4 C-3 -1 -9 0 -9 5 C-9 9.5 -4 13 0 16 C4 13 9 9.5 9 5 C9 0 3 -1 0 4 Z" fill="' + c.dark + '"/>' +
      '<ellipse cx="368" cy="432" rx="62" ry="38" fill="' + c.cheek + '" opacity=".5"/>' +
      '<ellipse cx="602" cy="432" rx="62" ry="38" fill="' + c.cheek + '" opacity=".5"/>'
    );
  }
  // Bicolor (ginger-&-white) markings modelled on Rob's cat: white base fur with
  // ginger patches over the head-cap+ears, the back/saddle, and the tail; subtle
  // tabby ticks on the orange; faint blush. Ellipses bleed past the silhouette so
  // the clip trims them flush to the outline (no white rim along the back).
  function bicolorMarks(c) {
    return (
      // mostly WHITE body with discrete ginger patches (Aslam is white-dominant):
      '<ellipse cx="470" cy="150" rx="205" ry="170" fill="' + c.patch + '"/>' +     // ginger head cap + ears (white muzzle/chin below)
      '<ellipse cx="452" cy="250" rx="46" ry="118" fill="' + (c.belly || "#fff") + '"/>' + // white forehead blaze splitting the cap
      '<ellipse cx="770" cy="300" rx="165" ry="150" fill="' + c.patch + '"/>' +     // shoulder patch
      '<ellipse cx="1245" cy="335" rx="255" ry="240" fill="' + c.patch + '"/>' +    // rump patch
      '<ellipse cx="1520" cy="430" rx="235" ry="185" fill="' + c.patch + '"/>' +    // ginger tail
      '<g fill="none" stroke="' + c.patchDark + '" stroke-width="26" stroke-linecap="round" opacity=".6">' +
        '<path d="M1150 215 Q1120 300 1150 385"/>' +     // tabby ticks on the rump
        '<path d="M1260 205 Q1230 295 1260 385"/>' +
        '<path d="M1370 215 Q1340 300 1370 385"/>' +
        '<path d="M470 55 Q452 115 470 180"/>' +         // a couple on the head cap
        '<path d="M548 70 Q530 128 548 196"/>' +
      '</g>' +
      '<ellipse cx="372" cy="430" rx="56" ry="33" fill="' + c.cheek + '" opacity=".5"/>' +
      '<ellipse cx="600" cy="430" rx="56" ry="33" fill="' + c.cheek + '" opacity=".5"/>'
    );
  }
  // Brown-grey mackerel tabby (Pruna). Base fur is already the warm grey-brown; on top
  // we lay: a darker "saddle" of mackerel stripes ribbing the back/flank (roughly
  // vertical bars), dark rings on the tail (far right ~x1500), a cream belly/chest
  // patch sweeping under the head, the tabby forehead "M" + dark ear caps, and faint
  // blush. Stripes bleed past the silhouette so the clip trims them flush.
  function tabbyMarks(c) {
    const st = c.stripe || c.dark;
    return (
      // cream chest/belly — sits low-left under the head, the pale front Pruna shows
      '<ellipse cx="470" cy="540" rx="230" ry="150" fill="' + c.belly + '" opacity=".9"/>' +
      '<ellipse cx="700" cy="600" rx="170" ry="110" fill="' + c.belly + '" opacity=".55"/>' +
      // dark ear caps
      '<path d="M298 150 Q345 30 425 110 Q360 130 320 175 Z" fill="' + st + '"/>' +
      '<path d="M548 150 Q600 30 660 122 Q600 130 565 170 Z" fill="' + st + '"/>' +
      // tabby forehead "M" — three short dark bars on the brow, above the eyes
      '<g fill="none" stroke="' + st + '" stroke-width="24" stroke-linecap="round" opacity=".92">' +
        '<path d="M430 232 L430 188"/>' +
        '<path d="M384 244 Q396 205 408 196"/>' +
        '<path d="M476 244 Q464 205 452 196"/>' +
      '</g>' +
      // mackerel stripes ribbing the back + flank (roughly vertical bars sweeping with
      // the spine, denser toward the rump). They run from the back-line down the side.
      '<g fill="none" stroke="' + st + '" stroke-width="40" stroke-linecap="round" opacity=".82">' +
        '<path d="M760 150 Q745 320 800 470"/>' +
        '<path d="M880 130 Q865 320 920 480"/>' +
        '<path d="M1000 130 Q985 330 1045 490"/>' +
        '<path d="M1120 140 Q1105 340 1170 500"/>' +
        '<path d="M1240 160 Q1230 350 1300 510"/>' +
        '<path d="M1360 190 Q1360 360 1430 510"/>' +
      '</g>' +
      // dark spine line down the back
      '<path d="M720 120 Q1050 70 1400 150" fill="none" stroke="' + st + '" stroke-width="34" stroke-linecap="round" opacity=".5"/>' +
      // dark tail rings (tail is the far-right lobe ~x1450-1720 / y300-560)
      '<g fill="none" stroke="' + st + '" stroke-width="46" stroke-linecap="round" opacity=".88">' +
        '<path d="M1500 230 Q1560 350 1500 470"/>' +
        '<path d="M1590 250 Q1650 360 1590 470"/>' +
        '<path d="M1680 290 Q1730 370 1680 450"/>' +
      '</g>' +
      // faint blush on the cheeks
      '<ellipse cx="372" cy="445" rx="54" ry="32" fill="' + c.cheek + '" opacity=".45"/>' +
      '<ellipse cx="600" cy="445" rx="54" ry="32" fill="' + c.cheek + '" opacity=".45"/>'
    );
  }


  /* Build the resting pet in its species trace frame.
     awake → open round eyes (over the muzzle); else the traced sleepy arcs.
     species 'cat' (1744x720, TT) or 'mastiff' (its own bespoke build below). */
  // Build the mastiff (Senda) — bespoke anatomy: fawn body, clipped saddle/belly/mask,
  // a long droopy black ear in front + a far-ear tip behind, blunt nose, sleepy eye.
  // Always uses the Senda palette colours (passed in c), ignoring the recolour hues.
  function mastiffBody(c, awake, hat) {
    const cid = "fpM" + (++clipSeq);
    const fur = c.fur || "#C9A05A", saddle = c.saddle || "#8A6A3A",
          belly = c.belly || "#E2C68C", mask = c.mask || "#2E2620",
          ear = c.ear || OUT, nose = c.noseFill || "#1E1812", cheek = c.cheek || "#C98B7E";
    const M = MASTIFF_P;
    // chunky doodle line, matching the cat/dog outline weight (drawn in the 2360 frame)
    const stroke = 'stroke="' + OUT + '" stroke-width="22" stroke-linejoin="round" stroke-linecap="round"';
    const eye = awake
      ? '<ellipse cx="' + M.eyeOpen.cx + '" cy="' + M.eyeOpen.cy + '" rx="' + M.eyeOpen.rx + '" ry="' + M.eyeOpen.ry + '" fill="' + OUT + '"/>' +
        '<circle cx="' + (M.eyeOpen.cx + 18) + '" cy="' + (M.eyeOpen.cy - 24) + '" r="' + M.eyeOpen.hl + '" fill="#fff"/>'
      : '<path d="' + M.eyeClosed + '" fill="none" stroke="#0c0a08" stroke-width="24" stroke-linecap="round"/>';
    return (
      // traced body silhouette (fur), drawn under the potrace y-flip transform, with a
      // chunky doodle outline (stroke) — same loose line as the cat/dog
      '<g ' + MTT + '><path d="' + M.sil + '" fill="' + fur + '" stroke="' + OUT + '" stroke-width="220" stroke-linejoin="round" stroke-linecap="round"/></g>' +
      // clipped overlays — authored UPRIGHT in the same frame (outside MTT), clipped to
      // the traced silhouette. CLIP GOTCHA: the transform goes on the <path> in the
      // clipPath, never a wrapping <g>.
      '<clipPath id="' + cid + '"><path ' + MTT + ' d="' + M.sil + '"/></clipPath>' +
      '<g clip-path="url(#' + cid + ')">' +
        '<path d="' + M.saddle + '" fill="' + saddle + '" opacity=".5"/>' +
        '<path d="' + M.belly + '" fill="' + belly + '" opacity=".55"/>' +
        '<path d="' + M.earFar + '" fill="#241712" opacity=".9"/>' +
        '<path d="' + M.mask + '" fill="' + mask + '" opacity=".96"/>' +
        '<ellipse cx="' + M.cheek.cx + '" cy="' + M.cheek.cy + '" rx="' + M.cheek.rx + '" ry="' + M.cheek.ry + '" fill="' + cheek + '" opacity=".36"/>' +
      '</g>' +
      // near droopy ear (black, hanging down the left in front of the cheek)
      '<path d="' + M.earNear + '" fill="' + ear + '" ' + stroke + '/>' +
      // blunt nose at the muzzle tip
      '<ellipse cx="' + M.nose.cx + '" cy="' + M.nose.cy + '" rx="' + M.nose.rx + '" ry="' + M.nose.ry + '" fill="' + nose + '"/>' +
      eye +
      hatSVG(hat, "mastiff")
    );
  }

  let clipSeq = 0;
  function petBody(species, c, awake, hat) {
    if (species === "mastiff") return mastiffBody(c, awake, hat);
    const cid = "fpBody" + (++clipSeq);
    const A = P;                          // cat path set
    const T = TT;                         // trace transform
    // open-eye centres (measured off the traced muzzle):
    const eyeGeo = { lx: 460, rx: 660, ey: 385, rx_: 34, ry_: 40, hl: 11 };
    const eyes = awake
      ? '<g ' + T + '><path d="' + A.eyeL + '" fill="' + c.fur + '"/><path d="' + A.eyeR + '" fill="' + c.fur + '"/></g>' +
        '<ellipse cx="' + eyeGeo.lx + '" cy="' + eyeGeo.ey + '" rx="' + eyeGeo.rx_ + '" ry="' + eyeGeo.ry_ + '" fill="' + OUT + '"/><circle cx="' + (eyeGeo.lx + 12) + '" cy="' + (eyeGeo.ey - 17) + '" r="' + eyeGeo.hl + '" fill="#fff"/>' +
        '<ellipse cx="' + eyeGeo.rx + '" cy="' + eyeGeo.ey + '" rx="' + eyeGeo.rx_ + '" ry="' + eyeGeo.ry_ + '" fill="' + OUT + '"/><circle cx="' + (eyeGeo.rx + 12) + '" cy="' + (eyeGeo.ey - 17) + '" r="' + eyeGeo.hl + '" fill="#fff"/>'
      : '<g ' + T + '><path d="' + A.eyeL + '" fill="' + OUT + '"/><path d="' + A.eyeR + '" fill="' + OUT + '"/></g>';

    const marks = c.pattern === "bicolor" ? bicolorMarks(c)
                : (c.pattern === "tabby" ? tabbyMarks(c) : normalMarks(c));

    return (
      // silhouette (fur)
      '<g ' + T + '><path d="' + A.sil + '" fill="' + c.fur + '"/></g>' +
      // recolourable overlays, clipped to the body
      '<clipPath id="' + cid + '"><path ' + T + ' d="' + A.sil + '"/></clipPath>' +
      '<g clip-path="url(#' + cid + ')">' + marks + '</g>' +
      // outline on top (closed-eye arcs swapped for open when awake); nose can be tinted
      '<g ' + T + '><path d="' + A.outMain + '" fill="' + OUT + '"/><path d="' + A.nose + '" fill="' + (c.noseFill || OUT) + '"/></g>' +
      eyes +
      // hat last, perched on the head (per-species crown offset)
      hatSVG(hat, species)
    );
  }

  /* Build a full <svg> string. config: {name, furIdx, hat}. state: {awake:bool}
     The cat only exists in the resting pose (the iconic Piti) — there is no
     separate sitting pose; "awake" just opens the eyes. Faces LEFT (flip scaleX). */
  function svg(config, state) {
    let species = (config && config.species) || "cat";
    if (species !== "mastiff") species = "cat";
    // the mastiff (Senda) is a fixed look — always use its own palette entry.
    let c;
    if (species === "mastiff") {
      c = PALETTE.find(function (p) { return p.species === "mastiff"; }) || PALETTE[0];
    } else {
      c = PALETTE[(config && config.furIdx) || 0] || PALETTE[0];
    }
    const hat = (config && config.hat) || "none";
    state = state || {};
    // Fit the traced art into a 100x100 viewBox, vertically centred with hat headroom
    // (overflow:visible lets a tall hat spill). Each species has its own trace frame,
    // so each gets its own scale + offset chosen so the BODY lands at the same on-screen
    // size + baseline (the cat and the bigger mastiff share one on-screen footprint).
    let inner, fit;
    if (species === "mastiff") {
      // mastiff TRACED frame 2360x1120; the body occupies ~x188..2299 / ~y96..1061.
      // Senda is a BIG dog — render her ~1.4x the cat's on-screen footprint (the brief
      // asks ≥30% bigger). Scale so the ~2110-wide body fills the frame, then a touch
      // more; centre on the body bbox and rest on the cat's baseline.
      const scale = (100 / 2360) * 1.34;   // ≥30% larger than the cat on screen
      // centre the body bbox (x ~188..2299, mid ~1244) on x50, then nudge left a hair
      const tx = 50 - 1244 * scale - 2;
      const ty = (100 - 1120 * scale) / 2 + 10;  // rest low, hats overflow up
      fit = 'transform="translate(' + tx.toFixed(2) + ',' + ty.toFixed(2) + ') scale(' + scale.toFixed(5) + ')"';
    } else {
      const scale = 100 / 1744;                // ~0.05734
      const ty = (100 - 720 * scale) / 2 + 6;  // nudge down a touch; hats overflow up
      fit = 'transform="translate(0,' + ty.toFixed(2) + ') scale(' + scale.toFixed(5) + ')"';
    }
    return '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" overflow="visible">' +
      '<ellipse class="pt-shadow" cx="50" cy="84" rx="30" ry="5" fill="rgba(60,30,55,.16)"/>' +
      '<g ' + fit + '>' +
        petBody(species, c, !!state.awake, hat) +
      '</g>' +
    '</svg>';
  }

  // ---- config persistence ----
  function loadConfig() {
    const def = { name: "Pal", furIdx: 0, hat: "none", species: "cat" };
    let cfg;
    try { cfg = Object.assign(def, JSON.parse(localStorage.getItem("piti-config")) || {}); }
    catch (e) { cfg = Object.assign({}, def); }
    // Senda the mastiff replaced the old corgi — migrate any saved 'dog' config to her.
    if (cfg.species === "dog") cfg.species = "mastiff";
    return cfg;
  }
  function saveConfig(cfg) { try { localStorage.setItem("piti-config", JSON.stringify(cfg)); } catch (e) {} }

  /* ----------------------------------------------------------
     mount(): create the trailing companion overlay on a page.
     opts.size (px), opts.start {x,y}. Returns a control handle.
     pointer-events are OFF so it never blocks the UI.
  ---------------------------------------------------------- */
  const LIVE_SIZE = 55;   // cursor-sized companion (the live pal). Portrait passes its own.

  // little blue sweat-drop shown near the head when the pal is hustling to keep up
  const SWEAT_SVG =
    '<svg viewBox="0 0 12 16" width="100%" height="100%">' +
    '<path d="M6 0 C9 6 11 9 11 11 a5 5 0 0 1-10 0 C1 9 3 6 6 0 Z" fill="#8FD0FF" stroke="#3F90D0" stroke-width="0.7"/>' +
    '<ellipse cx="4.4" cy="9.5" rx="1.3" ry="2" fill="#CDEBFF" opacity=".8"/></svg>';

  function mount(opts) {
    opts = opts || {};
    const cfg = loadConfig();
    const size = opts.size || LIVE_SIZE;

    const el = document.createElement("div");
    el.className = "piti-companion";
    el.setAttribute("aria-hidden", "true");
    el.style.cssText =
      "position:fixed;left:0;top:0;width:" + size + "px;height:" + size + "px;z-index:2147483600;" +
      "pointer-events:none;will-change:transform;";
    // pt-inner carries the pop-in / hop motion; inside it, two stacked sprites
    // (resting sleepy eyes / awake open eyes) crossfade, plus a sweat-drop emote.
    el.innerHTML =
      '<div class="pt-inner">' +
        '<div class="pt-sprite pt-rest" style="opacity:1">' + svg(cfg, {}) + '</div>' +
        '<div class="pt-sprite pt-awake" style="opacity:0">' + svg(cfg, { awake: true }) + '</div>' +
        '<div class="pt-sweat" aria-hidden="true">' + SWEAT_SVG + '</div>' +
      '</div>' +
      '<div class="pt-zzz" aria-hidden="true">z</div>';
    document.body.appendChild(el);
    document.documentElement.classList.add("piti-cursor");   // Figma-style cursor while active

    // styles (once)
    if (!document.getElementById("piti-style")) {
      const st = document.createElement("style");
      st.id = "piti-style";
      st.textContent =
        ".piti-companion .pt-inner{position:absolute;inset:0;transform-origin:50% 82%}" +
        ".piti-companion .pt-sprite{position:absolute;inset:0;transition:opacity .18s ease}" +
        ".piti-companion svg{width:100%;height:100%;display:block;overflow:visible;transform-origin:50% 80%}" +
        ".piti-companion .pt-shadow{transition:rx .3s,opacity .3s}" +
        // gentle glide bob while travelling — a soft lift + slight squash, no hard steps (it's a curled cat)
        ".piti-companion.walk .pt-rest svg,.piti-companion.walk .pt-awake svg{animation:pt-glide .9s ease-in-out infinite}" +
        ".piti-companion.run .pt-rest svg,.piti-companion.run .pt-awake svg{animation-duration:.5s}" +
        "@keyframes pt-glide{" +
        "0%{transform:translateY(0) scaleY(1)}" +
        "50%{transform:translateY(-7%) scaleY(1.02)}" +
        "100%{transform:translateY(0) scaleY(1)}}" +
        // pop-in when summoned, and a startled hop on surprise
        ".piti-companion .pt-inner.pin{animation:pt-pop .46s cubic-bezier(.2,.9,.3,1.5)}" +
        "@keyframes pt-pop{0%{transform:scale(.2);opacity:0}55%{opacity:1}100%{transform:scale(1)}}" +
        ".piti-companion .pt-inner.hop{animation:pt-hop .52s cubic-bezier(.2,.9,.25,1.4)}" +
        "@keyframes pt-hop{0%{transform:translateY(0) scale(1,1)}20%{transform:translateY(6%) scale(1.14,.84)}52%{transform:translateY(-32%) scale(.9,1.12)}100%{transform:translateY(0) scale(1,1)}}" +
        // sweat-drop near the head when hustling to keep up
        ".piti-companion .pt-sweat{position:absolute;left:9%;top:6%;width:17%;height:21%;opacity:0}" +
        ".piti-companion.run .pt-sweat{animation:pt-sweat .85s ease-in-out infinite}" +
        "@keyframes pt-sweat{0%{opacity:0;transform:translateY(-8%) scale(.85)}35%{opacity:.95}100%{opacity:0;transform:translateY(40%) scale(1)}}" +
        ".piti-companion .pt-zzz{position:absolute;top:-4px;right:-2px;font:700 13px ui-rounded,system-ui,sans-serif;color:#9a8fb0;opacity:0}" +
        ".piti-companion.sleep .pt-zzz{animation:pt-zzz 2.6s ease-out infinite}" +
        "@keyframes pt-zzz{0%{opacity:0;transform:translate(0,4px) scale(.6)}30%{opacity:.9}100%{opacity:0;transform:translate(8px,-16px) scale(1.1)}}" +
        ".piti-bubble{position:fixed;z-index:2147483601;pointer-events:none;font-size:16px;opacity:0}" +
        ".piti-bubble.go{animation:pt-float 1.1s ease-out forwards}" +
        ".piti-bubble.pop{font-size:19px}" +
        ".piti-bubble.pop.go{animation:pt-bpop .8s cubic-bezier(.2,.9,.3,1.4) forwards}" +
        "@keyframes pt-float{0%{opacity:0;transform:translateY(0) scale(.4)}25%{opacity:1;transform:translateY(-10px) scale(1)}100%{opacity:0;transform:translateY(-44px) scale(.9)}}" +
        "@keyframes pt-bpop{0%{opacity:0;transform:translateY(0) scale(.2)}30%{opacity:1;transform:translateY(-12px) scale(1.15)}70%{opacity:1;transform:translateY(-16px) scale(1)}100%{opacity:0;transform:translateY(-22px) scale(.95)}}" +
        // motion after-image: faint ghost copies dropped behind while moving fast
        ".piti-echo{position:fixed;left:0;top:0;pointer-events:none;z-index:2147483598;opacity:.4}" +
        ".piti-echo svg{width:100%;height:100%;display:block;overflow:visible}" +
        ".piti-echo.go{animation:pt-echo .34s ease-out forwards}" +
        "@keyframes pt-echo{0%{opacity:.4}100%{opacity:0}}" +
        // the customizer opens as a real overlay modal — the site stays visible, dimmed
        ".piti-modal-backdrop{position:fixed;inset:0;z-index:2147483640;background:rgba(34,27,38,.55);display:grid;place-items:center;padding:20px;animation:pt-fade .2s ease both}" +
        "@keyframes pt-fade{from{opacity:0}to{opacity:1}}" +
        ".piti-modal-frame{width:480px;max-width:100%;height:600px;max-height:92vh;border:none;background:transparent;border-radius:20px}" +
        // Figma-style cursor while the piti is active (text fields keep the I-beam)
        "html.piti-cursor,html.piti-cursor *{cursor:url('" + CURSOR_URI + "') 5 3,auto !important}" +
        "html.piti-cursor input,html.piti-cursor textarea,html.piti-cursor [contenteditable]{cursor:text !important}" +
        "@media (prefers-reduced-motion: reduce){" +
        ".piti-companion.walk .pt-rest svg,.piti-companion.walk .pt-awake svg{animation:none}" +
        ".piti-companion .pt-inner.pin,.piti-companion .pt-inner.hop{animation:none}" +
        ".piti-companion.run .pt-sweat{animation:none;opacity:.9}" +
        ".piti-companion.sleep .pt-zzz{animation:none;opacity:.8}}";
      document.head.appendChild(st);
    }

    const rest = el.querySelector(".pt-rest");
    const awake = el.querySelector(".pt-awake");
    const inner = el.querySelector(".pt-inner");

    const pos = { x: (opts.start && opts.start.x) || innerWidth * 0.5,
                  y: (opts.start && opts.start.y) || innerHeight * 0.72 };
    const mouse = { x: pos.x, y: pos.y };
    // facing: target ±1 (deadzoned); facingNow eases toward it for a smooth flip.
    let facing = 1, facingNow = 1, walking = false, lastFlip = 0, runningHard = false;
    let lastMove = now(), lastT = now(), raf = 0, running = true, parked = false;
    let emoteUntil = 0, lastSurprise = 0, lastEcho = 0;
    const reduceMotion = (() => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) { return false; } })();

    function now() { return performance.now(); }

    function onMove(e) { mouse.x = e.clientX; mouse.y = e.clientY; lastMove = now(); wake(); }
    addEventListener("pointermove", onMove, { passive: true });

    // motion after-image: drop a faint, fading ghost of the current sprite at the
    // current spot; as the pal speeds on, the ghosts trail behind it.
    function dropEcho() {
      const e = document.createElement("div");
      e.className = "piti-echo";
      e.style.width = e.style.height = size + "px";
      e.style.transform = "translate(" + (pos.x - size / 2) + "px," + (pos.y - size / 2) + "px) scaleX(" + facingNow + ")";
      e.innerHTML = awake.innerHTML;   // current art (running → awake pose)
      document.body.appendChild(e);
      requestAnimationFrame(() => e.classList.add("go"));
      setTimeout(() => e.remove(), 360);
    }

    function bubble(glyph, cls) {
      const b = document.createElement("div");
      b.className = "piti-bubble" + (cls ? " " + cls : "");
      b.textContent = glyph;
      b.style.left = (pos.x + size * 0.30) + "px";
      b.style.top = (pos.y - size * (cls === "pop" ? 0.30 : 0.10)) + "px";
      document.body.appendChild(b);
      requestAnimationFrame(() => b.classList.add("go"));
      setTimeout(() => b.remove(), 1200);
    }
    function heartBubble() { bubble(["💕", "💗", "✨", "🩷"][Math.floor((now() / 137) % 4)]); }
    let nextHeart = now() + 6000;

    // startled "pop": a little hop + an exclaim bubble + eyes briefly open. Fired by
    // clicks on links/cards (a spiritual port of the Piti detach-component surprise).
    function surprise() {
      emoteUntil = now() + 750;
      inner.classList.remove("hop"); void inner.offsetWidth; inner.classList.add("hop");
      bubble("❗", "pop");
    }
    function onDown(e) {
      if (!el || (e.target && el.contains(e.target))) return;
      const hit = e.target && e.target.closest &&
        e.target.closest("a,button,[role=button],summary,.card-opp,.card-proto,.status-chip,.side-pin,.preview-link,.piti-paw");
      if (!hit) return;
      const t = now();
      if (t - lastSurprise < 850) return;
      lastSurprise = t; surprise(); wake();
    }
    addEventListener("pointerdown", onDown, true);

    // pop-in when it first appears
    requestAnimationFrame(function () { inner.classList.add("pin"); setTimeout(function () { inner.classList.remove("pin"); }, 540); });

    // Crossfade between the two stacked sprites (resting eyes vs open eyes).
    let curPose = "rest";
    function setPose(p) {
      if (p === curPose) return;
      curPose = p;
      const isSleep = p === "rest" || p === "sleep";
      rest.style.opacity = (p === "awake") ? "0" : "1";
      awake.style.opacity = (p === "awake") ? "1" : "0";
      el.classList.toggle("sleep", p === "sleep");
    }

    function frame() {
      if (!running) return;
      const t = now();
      // dt normalised to 60fps so the lerp feels identical on any refresh rate.
      const dt = Math.min(3, (t - lastT) / 16.667); lastT = t;
      const idle = t - lastMove;

      // Target: trail behind & a little below the cursor so it reads as "coming over".
      // After a short pause, lock the target so it settles cleanly (no rubber-band wobble).
      let tx, ty;
      if (idle > 650) {
        tx = pos.x; ty = pos.y;
      } else {
        tx = mouse.x - facing * size * 0.62;
        ty = mouse.y + size * 0.30;
      }
      tx = Math.max(size * 0.5, Math.min(innerWidth - size * 0.5, tx));
      ty = Math.max(size * 0.5, Math.min(innerHeight - size * 0.4, ty));

      const dx = tx - pos.x, dy = ty - pos.y;
      const dist = Math.hypot(dx, dy);

      // Time-based exponential ease toward the target (frame-rate independent).
      // Catch up a little faster the further behind it is, so a fast flick of the
      // cursor doesn't leave it crawling — but it still arrives and settles smoothly.
      const kBase = 0.15 + Math.min(0.13, dist / 1400);
      const k = 1 - Math.pow(1 - kBase, dt);
      pos.x += dx * k;
      pos.y += dy * (k * 1.18);

      // Walk hysteresis: only start gliding past a clear distance; only stop once arrived.
      if (!walking && dist > 14) walking = true;
      else if (walking && dist < 4) walking = false;
      el.classList.toggle("walk", walking);

      // Running hard (sweat) when it's lagging well behind the cursor; clears once close.
      if (!runningHard && dist > 64) runningHard = true;
      else if (runningHard && dist < 26) runningHard = false;
      el.classList.toggle("run", runningHard && walking);

      // After-image trail — only on BIG fast moves (cursor yanked far away), so it
      // rarely triggers in normal use. Skipped under reduced-motion.
      if (walking && !reduceMotion && dist > 165 && t - lastEcho > 40) { dropEcho(); lastEcho = t; }

      // Facing follows horizontal motion with a deadzone + a short commit window (≥320ms
      // between flips) so it can't dither. facingNow eases toward the target for a smooth flip.
      const wantFacing = dx > 0 ? 1 : -1;
      if (walking && Math.abs(dx) > 10 && wantFacing !== facing && (t - lastFlip) > 320) {
        facing = wantFacing; lastFlip = t;
      }
      facingNow += (facing - facingNow) * (1 - Math.pow(1 - 0.34, dt));
      if (Math.abs(facingNow - facing) < 0.02) facingNow = facing;

      // state machine: surprised → eyes open (held); travelling → eyes open;
      // settled → resting; long idle → sleep w/ zzz
      if (t < emoteUntil) {
        setPose("awake");
      } else if (walking) {
        setPose("awake");
      } else if (idle > 11000) {
        setPose("sleep");
      } else {
        setPose("rest");
        if (t > nextHeart && idle > 1500 && idle < 10000) { heartBubble(); nextHeart = t + 7000 + Math.random() * 6000; }
      }

      el.style.transform =
        "translate(" + (pos.x - size / 2) + "px, " + (pos.y - size / 2) + "px) scaleX(" + facingNow + ")";
      // Park the 60fps loop once fully asleep and settled — re-writing an identical
      // transform every frame is wasted main-thread work. pointermove/clicks wake it.
      if (curPose === "sleep" && !walking && dist < 0.5 && t >= emoteUntil) { parked = true; raf = 0; return; }
      raf = requestAnimationFrame(frame);
    }
    // Restart the loop after it parks (called from pointermove / click handlers).
    function wake() { if (running && parked) { parked = false; lastT = now(); raf = requestAnimationFrame(frame); } }
    raf = requestAnimationFrame(frame);

    return {
      el,
      destroy() { running = false; cancelAnimationFrame(raf); removeEventListener("pointermove", onMove); removeEventListener("pointerdown", onDown, true); el.remove(); document.documentElement.classList.remove("piti-cursor"); },
      // refresh(override) re-skins the live pal; pass a config for instant preview,
      // or omit to re-read whatever was last saved.
      refresh(override) { const ncfg = override || loadConfig();
        rest.innerHTML = svg(ncfg, {});
        awake.innerHTML = svg(ncfg, { awake: true }); },
    };
  }

  /* ----------------------------------------------------------
     auto(): the site-wide manager. Mounts ONE companion when
     revealed, and wires a global hotkey — Shift + Ñ — to summon
     or dismiss the pal from ANY page, instantly, no reload.
     Skips inside iframes so prototype PREVIEWS never spawn a pal
     (only the real top-level prototype view does).
  ---------------------------------------------------------- */
  let live = null, autoWired = false, autoOpts = {};

  function inIframe() { try { return window.top !== window.self; } catch (e) { return true; } }
  function isRevealed() { try { return localStorage.getItem("piti-revealed") === "1"; } catch (e) { return false; } }
  function ensureMounted() { if (!live) live = mount(autoOpts); return live; }

  function reveal() { try { localStorage.setItem("piti-revealed", "1"); } catch (e) {} ensureMounted(); }
  function hide() {
    try { localStorage.removeItem("piti-revealed"); } catch (e) {}
    if (live) { live.destroy(); live = null; }
  }
  function toggle() { isRevealed() ? hide() : reveal(); }
  // re-skin the live companion (if any) — pass a config for instant preview, else re-read saved
  function refreshLive(override) { if (live) live.refresh(override); }

  // ---- the customizer as a real overlay modal (the site stays visible, dimmed) ----
  let modalEl = null;
  function openModal() {
    if (modalEl) return;
    modalEl = document.createElement("div");
    modalEl.className = "piti-modal-backdrop";
    modalEl.innerHTML = '<iframe class="piti-modal-frame" src="/pitis/" title="Customize your Piti"></iframe>';
    modalEl.addEventListener("click", function (e) { if (e.target === modalEl) closeModal(); });
    document.body.appendChild(modalEl);
  }
  function closeModal() { if (modalEl) { modalEl.remove(); modalEl = null; } if (isRevealed()) ensureMounted(); refreshLive(); }

  function auto(opts) {
    autoOpts = opts || {};
    if (inIframe()) return;               // never run inside preview iframes
    if (isRevealed()) ensureMounted();
    if (autoWired) return; autoWired = true;
    // Shift + Ñ toggles the pal. Don't hijack it while typing in a field.
    addEventListener("keydown", function (e) {
      const t = e.target;
      if (e.key === "Escape" && modalEl) { closeModal(); return; }
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const isEnye = e.key === "Ñ" || e.key === "ñ" || e.code === "Semicolon"; // ñ key (Spanish layout)
      if (e.shiftKey && isEnye) { e.preventDefault(); toggle(); }
    });
    // The footer paw opens the customizer as an overlay instead of navigating away.
    addEventListener("click", function (e) {
      const paw = e.target && e.target.closest && e.target.closest(".piti-paw");
      if (paw) { e.preventDefault(); openModal(); }
    });
    // Messages from the customizer iframe (close / saved → refresh the live companion).
    addEventListener("message", function (e) {
      const d = e.data;
      if (!d || typeof d.piti === "undefined") return;
      if (d.piti === "close") closeModal();
      else if (d.piti === "saved") { if (isRevealed()) ensureMounted(); refreshLive(); }
    });
  }

  window.Piti = { PALETTE, HATS, svg, loadConfig, saveConfig, mount, auto, reveal, hide, toggle, refreshLive };
})();
