"""
Integration tests for scripts/generate-sdk.mjs.

Runs the generator against a minimal synthetic spec and asserts the output
TypeScript matches expected type signatures. No real API spec is touched --
tests are hermetic.
"""

import os
import subprocess
import sys
import tempfile
import textwrap
import unittest

REPO_ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
GENERATOR = os.path.join(REPO_ROOT, 'scripts', 'generate-sdk.mjs')


def run_generator(spec_yaml: str) -> str:
    """Write spec to a temp file, run the generator, return the output content."""
    with tempfile.TemporaryDirectory() as tmp:
        spec_path = os.path.join(tmp, 'spec.yaml')
        out_path = os.path.join(tmp, 'api.ts')
        with open(spec_path, 'w') as f:
            f.write(spec_yaml)

        env = {**os.environ, 'SDK_GEN_SPEC': spec_path, 'SDK_GEN_OUT': out_path}
        result = subprocess.run(
            ['node', GENERATOR],
            cwd=REPO_ROOT,
            env=env,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise RuntimeError(f'Generator failed:\nstdout: {result.stdout}\nstderr: {result.stderr}')

        with open(out_path) as f:
            return f.read()


MINIMAL_SPEC = textwrap.dedent("""\
    openapi: 3.1.0
    info:
      title: Test API
      version: 0.1.0
    paths:
      /api/widgets:
        get:
          operationId: listWidgets
          summary: List widgets
          responses:
            "200":
              description: ok
              content:
                application/json:
                  schema:
                    type: array
                    items:
                      $ref: "#/components/schemas/Widget"
        post:
          operationId: createWidget
          summary: Create widget
          requestBody:
            required: true
            content:
              application/json:
                schema:
                  $ref: "#/components/schemas/WidgetCreate"
          responses:
            "201":
              description: created
              content:
                application/json:
                  schema:
                    $ref: "#/components/schemas/Widget"
      /api/widgets/{id}:
        parameters:
          - name: id
            in: path
            required: true
            schema:
              type: integer
        delete:
          operationId: deleteWidget
          summary: Delete widget
          responses:
            "200":
              description: ok
              content:
                application/json:
                  schema:
                    $ref: "#/components/schemas/OkResponse"
    components:
      schemas:
        OkResponse:
          type: object
          required: [ok]
          properties:
            ok:
              type: boolean
        Widget:
          type: object
          required: [id, name, status]
          properties:
            id:
              type: integer
            name:
              type: string
            status:
              type: string
              enum: [active, archived]
            tags:
              type: array
              items:
                type: string
            meta:
              type: [object, "null"]
        WidgetCreate:
          type: object
          required: [name]
          properties:
            name:
              type: string
              description: Widget display name
            status:
              type: string
              enum: [active, archived]
""")


class TestGenerateSdk(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.output = run_generator(MINIMAL_SPEC)

    # ------------------------------------------------------------------
    # Header assertions
    # ------------------------------------------------------------------

    def test_header_auto_generated_comment(self):
        self.assertIn('// AUTO-GENERATED -- do not edit manually', self.output)

    def test_header_lists_source_spec(self):
        self.assertIn('// Source: ', self.output)

    # ------------------------------------------------------------------
    # Component schema -> interface
    # ------------------------------------------------------------------

    def test_okresponse_interface_emitted(self):
        self.assertIn('export interface OkResponse {', self.output)

    def test_okresponse_required_field_not_optional(self):
        # required field "ok" must NOT have "?"
        self.assertIn('ok: boolean;', self.output)
        self.assertNotIn('ok?: boolean;', self.output)

    def test_widget_interface_emitted(self):
        self.assertIn('export interface Widget {', self.output)

    def test_widget_required_id_field(self):
        self.assertIn('id: number;', self.output)

    def test_widget_required_name_field(self):
        self.assertIn('name: string;', self.output)

    def test_widget_status_enum_inline(self):
        self.assertIn("status: 'active' | 'archived';", self.output)

    def test_widget_tags_array(self):
        self.assertIn('tags?: string[];', self.output)

    def test_widget_meta_nullable(self):
        # meta is type: [object, "null"] -- should be nullable
        self.assertIn('meta?: Record<string, unknown> | null;', self.output)

    def test_widgetcreate_interface_emitted(self):
        self.assertIn('export interface WidgetCreate {', self.output)

    def test_widgetcreate_description_as_jsdoc(self):
        self.assertIn('/** Widget display name */', self.output)

    def test_widgetcreate_optional_status(self):
        # status is not in required list -> must be optional
        # Make sure status? appears within WidgetCreate context
        # Simple check: status? exists somewhere (Widget.status is required, WidgetCreate.status is optional)
        self.assertIn("status?: 'active' | 'archived';", self.output)

    # ------------------------------------------------------------------
    # Operation -> response aliases
    # ------------------------------------------------------------------

    def test_list_widgets_response_alias(self):
        self.assertIn('export type ListWidgetsResponse = Widget[]', self.output)

    def test_create_widget_request_alias(self):
        self.assertIn('export type CreateWidgetRequest = WidgetCreate', self.output)

    def test_create_widget_response_alias(self):
        self.assertIn('export type CreateWidgetResponse = Widget', self.output)

    def test_delete_widget_response_alias(self):
        self.assertIn('export type DeleteWidgetResponse = OkResponse', self.output)

    # ------------------------------------------------------------------
    # Utility types
    # ------------------------------------------------------------------

    def test_paginated_response_utility_type(self):
        self.assertIn('export type PaginatedResponse<T>', self.output)

    # ------------------------------------------------------------------
    # Idempotency
    # ------------------------------------------------------------------

    def test_idempotent(self):
        """Running twice on the same spec must produce identical output."""
        second_run = run_generator(MINIMAL_SPEC)
        self.assertEqual(self.output, second_run)

    # ------------------------------------------------------------------
    # Edge cases
    # ------------------------------------------------------------------

    def test_no_operationid_no_alias_emitted(self):
        """Operations without operationId must not produce type aliases."""
        spec_no_id = textwrap.dedent("""\
            openapi: 3.1.0
            info:
              title: No ID API
              version: 0.0.1
            paths:
              /api/foo:
                get:
                  summary: No id here
                  responses:
                    "200":
                      description: ok
            components:
              schemas: {}
        """)
        out = run_generator(spec_no_id)
        # Should not contain any operation-specific Request/Response aliases
        # (PaginatedResponse utility type is always emitted, that's expected)
        self.assertNotIn('export type NoIdHereResponse', out)
        self.assertNotIn('export type NoIdHereRequest', out)
        # Only the utility type export should be present
        lines_with_export_type = [l for l in out.splitlines() if 'export type ' in l and 'PaginatedResponse' not in l]
        self.assertEqual(lines_with_export_type, [], f'Unexpected type aliases: {lines_with_export_type}')

    def test_empty_spec_does_not_crash(self):
        """Minimal valid spec with no schemas or paths must not crash."""
        spec_empty = textwrap.dedent("""\
            openapi: 3.1.0
            info:
              title: Empty
              version: 0.0.1
            paths: {}
            components:
              schemas: {}
        """)
        out = run_generator(spec_empty)
        self.assertIn('AUTO-GENERATED', out)

    def test_allof_produces_intersection_type(self):
        """allOf: [$ref, inline object] must produce an intersection type."""
        spec_allof = textwrap.dedent("""\
            openapi: 3.1.0
            info:
              title: AllOf Test
              version: 0.0.1
            paths:
              /api/things:
                get:
                  operationId: getThings
                  summary: Get things
                  responses:
                    "200":
                      description: ok
                      content:
                        application/json:
                          schema:
                            allOf:
                              - $ref: "#/components/schemas/Base"
                              - type: object
            components:
              schemas:
                Base:
                  type: object
                  properties:
                    id:
                      type: integer
        """)
        out = run_generator(spec_allof)
        self.assertIn('Base & Record<string, unknown>', out)

    def test_oneof_produces_union_type(self):
        """oneOf: [a, b] in requestBody must produce a union type alias."""
        spec_oneof = textwrap.dedent("""\
            openapi: 3.1.0
            info:
              title: OneOf Test
              version: 0.0.1
            paths:
              /api/events:
                post:
                  operationId: recordEvent
                  summary: Record event
                  requestBody:
                    required: true
                    content:
                      application/json:
                        schema:
                          oneOf:
                            - $ref: "#/components/schemas/EventA"
                            - $ref: "#/components/schemas/EventB"
                  responses:
                    "200":
                      description: ok
            components:
              schemas:
                EventA:
                  type: object
                  properties:
                    a:
                      type: string
                EventB:
                  type: object
                  properties:
                    b:
                      type: integer
        """)
        out = run_generator(spec_oneof)
        self.assertIn('export type RecordEventRequest = EventA | EventB', out)


if __name__ == '__main__':
    unittest.main(verbosity=2)
