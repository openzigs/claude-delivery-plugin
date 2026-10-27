# Persist the inventory

The inventory lives only in memory. Plan the work to save and load it as a JSON file:

- a `save(stock, path)` and `load(path)` pair, with an atomic write (temp file + rename)
- a format version field, and loading the unversioned files older tools wrote
- what happens on a corrupt or missing file
- tests for each

Keep it small: this module has no dependencies and should not gain any.
