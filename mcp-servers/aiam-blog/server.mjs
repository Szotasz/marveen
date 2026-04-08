#!/usr/bin/env node
/**
 * AIAM Blog API MCP Server
 * Provides tools for managing blog posts on aiamindennapokban.hu
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load API key from .env
function loadApiKey() {
  try {
    const envPath = join(__dirname, '..', '..', '.env')
    const content = readFileSync(envPath, 'utf-8')
    const match = content.match(/AIAM_BLOG_API_KEY=(.+)/)
    return match?.[1]?.trim()
  } catch {
    return process.env.AIAM_BLOG_API_KEY
  }
}

const API_KEY = loadApiKey()
const BASE_URL = 'https://ymljpjpjrwbmkfvtahtn.supabase.co/functions/v1/blog-api'

if (!API_KEY) {
  process.stderr.write('AIAM Blog MCP: AIAM_BLOG_API_KEY not found in .env\n')
  process.exit(1)
}

const server = new Server(
  { name: 'aiam-blog', version: '1.0.0' },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'blog_create_post',
      description: 'Create a new blog post on aiamindennapokban.hu. Use this when you need to publish content to the AI a mindennapokban blog. Supports HTML content, draft/published status.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Blog post title' },
          slug: { type: 'string', description: 'URL slug (lowercase, hyphens, no special chars). E.g. "claude-mythos-bejelentes"' },
          content: { type: 'string', description: 'Blog post content in HTML format. Use <p>, <h2>, <h3>, <ul>, <li>, <strong>, <em>, <a>, <blockquote>, <code> tags.' },
          excerpt: { type: 'string', description: 'Short description/excerpt (1-2 sentences)' },
          status: { type: 'string', enum: ['draft', 'published'], description: 'Post status. Use "draft" by default, "published" only when explicitly asked.' },
        },
        required: ['title', 'slug', 'content', 'excerpt'],
      },
    },
    {
      name: 'blog_update_post',
      description: 'Update an existing blog post on aiamindennapokban.hu. Requires the post ID.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Post UUID to update' },
          title: { type: 'string', description: 'New title (optional)' },
          slug: { type: 'string', description: 'New slug (optional)' },
          content: { type: 'string', description: 'New HTML content (optional)' },
          excerpt: { type: 'string', description: 'New excerpt (optional)' },
          status: { type: 'string', enum: ['draft', 'published'], description: 'New status (optional)' },
        },
        required: ['id'],
      },
    },
    {
      name: 'blog_list_posts',
      description: 'List blog posts from aiamindennapokban.hu. Returns titles, IDs, statuses, and dates.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['draft', 'published', 'all'], description: 'Filter by status (default: all)' },
          limit: { type: 'number', description: 'Max results (default: 20)' },
        },
      },
    },
    {
      name: 'blog_upload_image',
      description: 'Upload an image to a blog post on aiamindennapokban.hu. The image must be a local file path.',
      inputSchema: {
        type: 'object',
        properties: {
          post_id: { type: 'string', description: 'Post UUID to attach image to' },
          file_path: { type: 'string', description: 'Absolute path to the image file' },
        },
        required: ['post_id', 'file_path'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    if (name === 'blog_create_post') {
      const res = await fetch(BASE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'create_post',
          data: {
            title: args.title,
            slug: args.slug,
            content: args.content,
            excerpt: args.excerpt,
            status: args.status || 'draft',
          },
        }),
      })
      const data = await res.json()
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    if (name === 'blog_update_post') {
      const updateData = {}
      if (args.title) updateData.title = args.title
      if (args.slug) updateData.slug = args.slug
      if (args.content) updateData.content = args.content
      if (args.excerpt) updateData.excerpt = args.excerpt
      if (args.status) updateData.status = args.status

      const res = await fetch(BASE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'update_post',
          data: { id: args.id, ...updateData },
        }),
      })
      const data = await res.json()
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    if (name === 'blog_list_posts') {
      const res = await fetch(BASE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'list_posts',
          data: {
            status: args?.status || 'all',
            limit: args?.limit || 20,
          },
        }),
      })
      const data = await res.json()
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    if (name === 'blog_upload_image') {
      const fileData = readFileSync(args.file_path)
      const fileName = args.file_path.split('/').pop()
      const boundary = '----MCP' + Date.now()

      const parts = []
      // post_id field
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="post_id"\r\n\r\n${args.post_id}\r\n`))
      // file field
      const mimeType = fileName.match(/\.png$/i) ? 'image/png' :
                       fileName.match(/\.gif$/i) ? 'image/gif' :
                       fileName.match(/\.webp$/i) ? 'image/webp' : 'image/jpeg'
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`))
      parts.push(fileData)
      parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))

      const body = Buffer.concat(parts)
      const res = await fetch(BASE_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      })
      const data = await res.json()
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
