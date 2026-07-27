-- Migration 0002: add depth column to kanban_cards
--
-- A single adjacency-list parent_id is not enough to enforce a max-depth
-- constraint or to do efficient depth-gated UI rendering. The `depth` column
-- is a denormalized cache of each card's distance from the tree root.
--
-- Rules enforced at the application layer:
--   * depth 0 = top-level card (parent_id IS NULL)
--   * depth 1 = direct subtask
--   * depth 2 = sub-subtask (deepest allowed)
--   * Creating / reparenting a card so that any descendant would reach
--     depth 3 is rejected with HTTP 400.
--
-- The backfill uses a WITH RECURSIVE CTE so cards already at depth 2
-- (e.g. the #307 -> #309 -> #310..317 tree) get the correct value instead
-- of the wrong flat depth=1 that a simple WHERE parent_id IS NOT NULL
-- would assign.

ALTER TABLE kanban_cards ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;

-- Backfill: walk the adjacency tree and stamp every card with its true depth.
WITH RECURSIVE tree(id, depth_val) AS (
  SELECT id, 0 FROM kanban_cards WHERE parent_id IS NULL
  UNION ALL
  SELECT c.id, t.depth_val + 1
  FROM kanban_cards c
  JOIN tree t ON c.parent_id = t.id
)
UPDATE kanban_cards
SET depth = (SELECT depth_val FROM tree WHERE tree.id = kanban_cards.id)
WHERE EXISTS (SELECT 1 FROM tree WHERE tree.id = kanban_cards.id);
