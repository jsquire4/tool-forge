# Stage: Eval Writing

Goal: generate eval cases for the tool.

Steps:
- Ask the user for their desired eval mix:
  - Golden evals: straightforward, single-tool focus cases
  - Labeled evals: mix of straightforward / ambiguous / edge / adversarial
- Suggest a default mix if the user is unsure (e.g. 10 golden + 10 labeled)
- Generate eval cases based on the confirmed mix
- Write eval files to disk when the user confirms

Evals should test the tool in isolation — not in combination with other tools.
