# Gmail MCP Server

A comprehensive **Model Context Protocol (MCP) server** for Gmail integration with SIYA/Claude Desktop and other MCP-compatible clients. Features **on-demand authentication**, **multi-user support**, and **complete Gmail API access**.

## 📋 Table of Contents

- [✨ Features](#-features)
- [📦 Quick Start](#-quick-start)
- [🔧 Gmail API Setup](#-gmail-api-setup)
- [🎯 Authentication Methods](#-authentication-methods)
- [🚀 How It Works](#-how-it-works)
- [📧 Available Tools](#-available-tools)
- [💡 Usage Examples](#-usage-examples)
- [🎯 Common Use Cases](#-common-use-cases)
- [👥 Multi-User Mode](#-multi-user-mode)
- [🛠️ NPX Troubleshooting](#️-npx-troubleshooting-macos--nvm)
- [🔍 Debug & Troubleshooting](#-debug--troubleshooting)
- [📋 Command Line Options](#-command-line-options)
- [🔒 Security & Privacy](#-security--privacy)
- [🏗️ Advanced Configuration](#️-advanced-configuration)
- [📚 API Reference](#-api-reference)

## ✨ Features

- 🔐 **On-Demand Authentication** - Only authenticates when you use Gmail tools
- 📧 **Complete Gmail Operations** - Send, read, search, organize emails  
- 📝 **Draft Management** - Create, edit, and manage email drafts
- 👥 **Multi-User Support** - Handle multiple Gmail accounts simultaneously
- 🛡️ **Secure OAuth2** - Industry-standard Google authentication
- 🔧 **Flexible Configuration** - Multiple credential methods
- 🚀 **Zero-Config Startup** - Server starts immediately, authenticates when needed
- 📎 **Attachment Support** - Handle email attachments with full MIME support
- 🌍 **International Support** - Full UTF-8 and international character support

## 📦 Quick Start

### For SIYA/Claude Desktop

Add to your `siya_desktop_config.json` or `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gmail": {
      "command": "npx",
      "args": [
        "gmail-mcp-server@latest",
        "--client-id", "your-google-oauth2-client-id",
        "--client-secret", "your-google-oauth2-client-secret"
      ]
    }
  }
}
```

**Optional**: Add custom redirect URI if needed:
```json
{
  "mcpServers": {
    "gmail": {
      "command": "npx",
      "args": [
        "gmail-mcp-server@latest",
        "--client-id", "your-google-oauth2-client-id",
        "--client-secret", "your-google-oauth2-client-secret",
        "--redirect-uri", "http://localhost:8080/oauth2callback"
      ]
    }
  }
}
```

**⚠️ macOS with NVM Users**: If you get "spawn npx ENOENT" error, see [NPX Troubleshooting](#-npx-troubleshooting-macos--nvm).

### Test Installation

```bash
npx gmail-mcp-server@latest --help
```

## 🔧 Gmail API Setup

### 1. Enable Gmail API
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project
3. Enable the **Gmail API**
4. Go to **Credentials** → **Create Credentials** → **OAuth 2.0 Client ID**
5. Choose **Desktop Application**
6. Note your **Client ID** and **Client Secret**

### 2. Configure OAuth2 Redirect
- **Default**: Add `http://localhost:44000/oauth2callback` to authorized redirect URIs
- **Custom**: If using `--redirect-uri` or `GMAIL_REDIRECT_URI`, add your custom URI
- **Multi-user**: Add `http://localhost:44000/oauth2callback` through `http://localhost:44010/oauth2callback`

**Examples of redirect URIs to add:**
```
http://localhost:44000/oauth2callback  (default)
http://localhost:8080/oauth2callback  (custom port)
https://yourdomain.com/oauth2callback (production)
```

## 🎯 Authentication Methods

The server supports **three ways** to provide credentials:

### Method 1: Command Line Arguments (Recommended)
```json
{
  "mcpServers": {
    "gmail": {
      "command": "npx",
      "args": [
        "gmail-mcp-server@latest",
        "--client-id", "676239218521-example.apps.googleusercontent.com",
        "--client-secret", "GOCSPX-example-secret",
        "--redirect-uri", "http://localhost:8080/oauth2callback"
      ]
    }
  }
}
```

**Note**: The `--redirect-uri` is optional and defaults to `http://localhost:44000/oauth2callback`.

### Method 2: Environment Variables
```bash
export GMAIL_CLIENT_ID="your-client-id"
export GMAIL_CLIENT_SECRET="your-client-secret"
export GMAIL_REDIRECT_URI="http://localhost:8080/oauth2callback"  # Optional, defaults to http://localhost:44000/oauth2callback
npx gmail-mcp-server@latest
```

### Method 3: Credentials File
```bash
# Download OAuth2 JSON from Google Cloud Console
mkdir -p ~/.gmail-mcp
cp /path/to/credentials.json ~/.gmail-mcp/credentials.json
npx gmail-mcp-server@latest
```

### 🔄 Automatic Token Refresh
**Once authenticated, you stay signed in for months!** The server automatically:
- Refreshes expired access tokens using stored refresh tokens
- Maintains long-term authentication without requiring re-authentication
- Only prompts for new authentication if refresh tokens become invalid

This means you authenticate once and use Gmail tools seamlessly for months without interruption.

## 🚀 How It Works

### On-Demand Authentication
The server starts **immediately** without requiring authentication upfront:

```
📧 Gmail MCP Server starting...
🔐 Authentication will be handled when you use Gmail tools or call "quick_authenticate"
```

### When You Use Gmail Tools
First time you try any Gmail operation, you'll see:

```
🔐 **Authentication Required**

To use Gmail tools, please authenticate first:

**Option 1:** Use the `gmail_authenticate` tool with mode='auto' for automatic authentication
**Option 2:** Use the `gmail_authenticate` tool with mode='manual' to get a clickable authentication link

After authentication, you can use all Gmail tools!
```

## 📧 Available Tools

Once authenticated, you have access to:

### Email Operations
- **gmail_send_email** - Send emails with attachments and HTML
- **gmail_read_email** - Read email content and metadata  
- **gmail_search_emails** - Advanced Gmail search with filters
- **gmail_mark_email** - Mark as read/unread
- **gmail_move_email** - Move between folders/labels
- **gmail_delete_email** - Permanently delete emails
- **gmail_get_attachment** - Download email attachments

### Draft Management
- **gmail_draft** - Comprehensive draft management with actions: create, list, get, update, delete, send

### Authentication & Session
- **gmail_authenticate** - Authentication with auto/manual modes
- **gmail_logout** - Sign out and clear credentials

### Multi-User Tools (when using `--multi-user`)
- **gmail_authenticate_user** - Add new user accounts
- **gmail_manage_session** - Manage user sessions (info/remove)

## 💡 Usage Examples

### Send an Email
```json
{
  "tool": "gmail_send_email",
  "arguments": {
    "to": ["recipient@example.com"],
    "subject": "Hello from SIYA!",
    "text": "This is a plain text email.",
    "html": "<h1>Hello!</h1><p>This is an <strong>HTML</strong> email.</p>"
  }
}
```

### Create a Draft
```json
{
  "tool": "gmail_draft",
  "arguments": {
    "action": "create",
    "to": ["recipient@example.com"],
    "subject": "Draft Email",
    "text": "This will be saved as a draft.",
    "attachments": [
      {
        "filename": "document.pdf",
        "content": "base64-encoded-content",
        "contentType": "application/pdf"
      }
    ]
  }
}
```

### Search Emails
```json
{
  "tool": "gmail_search_emails",
  "arguments": {
    "query": "is:unread has:attachment",
    "maxResults": 10
  }
}
```

### List Drafts
```json
{
  "tool": "gmail_draft",
  "arguments": {
    "action": "list",
    "maxResults": 20
  }
}
```

### Update Draft
```json
{
  "tool": "gmail_draft",
  "arguments": {
    "action": "update",
    "draftId": "draft_id_here",
    "to": ["updated@example.com"],
    "subject": "Updated Draft Subject",
    "text": "Updated draft content"
  }
}
```

### Send Draft
```json
{
  "tool": "gmail_draft",
  "arguments": {
    "action": "send",
    "draftId": "draft_id_here"
  }
}
```

## 🎯 Common Use Cases

### Email Automation
- **Newsletter Management** - Send bulk emails with personalized content
- **Notification Systems** - Automated alerts and status updates
- **Customer Communication** - Automated responses and follow-ups

### Content Management
- **Draft Workflows** - Create, review, and collaborate on email content
- **Template Management** - Save and reuse email templates as drafts
- **Content Scheduling** - Prepare emails in advance for later sending

### Email Analysis
- **Inbox Monitoring** - Track unread emails and important messages
- **Attachment Processing** - Extract and process email attachments
- **Search & Filter** - Find specific emails based on complex criteria

### Multi-Account Management
- **Team Collaboration** - Manage multiple team member accounts
- **Client Communication** - Handle emails from different business accounts
- **Personal/Business Separation** - Organize multiple Gmail accounts

## 👥 Multi-User Mode

Enable multiple Gmail accounts with the `--multi-user` flag:

```bash
npx gmail-mcp-server@latest --multi-user --client-id "your-id" --client-secret "your-secret"
```

### Multi-User Workflow
1. **Start server** with `--multi-user` flag
2. **Add users** with `gmail_authenticate_user` 
3. **Use tools** with `userId` parameter for each operation
4. **Manage sessions** with `gmail_manage_session`

### Multi-User Example
```json
{
  "tool": "gmail_authenticate_user",
  "arguments": {
    "userEmail": "user1@gmail.com"
  }
}
```

After authentication, use the returned `userId` for operations:
```json
{
  "tool": "gmail_send_email",
  "arguments": {
    "userId": "user_12345",
    "to": ["recipient@example.com"],
    "subject": "Email from User 1",
    "text": "This email is sent from user1@gmail.com account"
  }
}
```

## 🛠️ NPX Troubleshooting (macOS + NVM)

If you get "spawn npx ENOENT" error on macOS with NVM:

### Solution: Create NPX Wrapper

```bash
# Create wrapper directory
mkdir -p ~/bin

# Create NPX wrapper script
echo '#!/bin/bash' > ~/bin/npx
echo 'exec ~/.nvm/versions/node/v22.14.0/bin/npx "$@"' >> ~/bin/npx
chmod +x ~/bin/npx

# Update SIYA/Claude Desktop config
```

**Updated SIYA/Claude Desktop Config:**
```json
{
  "mcpServers": {
    "gmail": {
      "command": "/Users/yourusername/bin/npx",
      "args": [
        "gmail-mcp-server@latest",
        "--client-id", "your-client-id",
        "--client-secret", "your-client-secret"
      ]
    }
  }
}
```

**Replace `/Users/yourusername/` with your actual home directory path.**

### Find Your Node Version
```bash
node --version  # e.g., v22.14.0
ls ~/.nvm/versions/node/  # List available versions
```

## 🔍 Debug & Troubleshooting  

### Enable Debug Mode
```bash
npx gmail-mcp-server@latest --debug --client-id "your-id" --client-secret "your-secret"
```

### Common Issues

**"Gmail credentials not configured"**
- Use `npm uninstall -g gmail-mcp-server` to clear cache
- Use `npx gmail-mcp-server@latest` to force latest version

**"spawn npx ENOENT"**  
- Follow [NPX Troubleshooting](#-npx-troubleshooting-macos--nvm) above
- Ensure NPX wrapper has correct Node.js path

**"Duplicate tools showing up"**
- Update to version 1.0.17+ which fixes duplicate tool issues
- Use `npx gmail-mcp-server@latest` to get latest version

**Authentication popup on startup**
- Update to version 1.0.11+ for on-demand authentication
- Use `npx gmail-mcp-server@latest` to get latest version

### Version Check
```bash
npx gmail-mcp-server@latest --help  # Shows current version info
```

## 📋 Command Line Options

```bash
npx gmail-mcp-server@latest [options]

Options:
  --client-id <id>           OAuth2 client ID
  --client-secret <secret>   OAuth2 client secret
  --redirect-uri <uri>       OAuth2 redirect URI (default: http://localhost:44000/oauth2callback)
  --multi-user              Enable multi-user mode
  --setup-auth              Interactive credential setup
  --reset-auth              Clear stored authentication
  --debug                   Enable debug logging
  --non-interactive         Run without prompts
  --help                    Show help information
```

### Examples with Custom Redirect URI
```bash
# Custom port
npx gmail-mcp-server@latest --client-id "your-id" --client-secret "your-secret" --redirect-uri "http://localhost:8080/oauth2callback"

# Production domain
npx gmail-mcp-server@latest --client-id "your-id" --client-secret "your-secret" --redirect-uri "https://myapp.com/gmail/callback"

# Environment variable (alternative)
export GMAIL_REDIRECT_URI="http://localhost:3000/auth/callback"
npx gmail-mcp-server@latest --client-id "your-id" --client-secret "your-secret"
```

## 🔒 Security & Privacy

- **OAuth2 Standard** - Uses Google's official authentication
- **Local Storage** - Tokens stored locally in `~/.gmail-mcp/`
- **No Data Collection** - Your emails stay on Google's servers
- **Secure Scopes** - Only requests necessary Gmail permissions

## 🏗️ Advanced Configuration

### Custom Redirect URI Configuration

The server supports flexible redirect URI configuration for different deployment scenarios:

**Default Configuration:**
- Uses `http://localhost:44000/oauth2callback`
- Automatically starts callback server on port 44000

**Custom Port Example:**
```bash
# Command line
npx gmail-mcp-server@latest --redirect-uri "http://localhost:8080/oauth2callback"

# Environment variable
export GMAIL_REDIRECT_URI="http://localhost:8080/oauth2callback"
npx gmail-mcp-server@latest
```

**Production Deployment:**
```bash
# For production with custom domain
npx gmail-mcp-server@latest --redirect-uri "https://myapp.com/gmail/callback"
```

**Key Features:**
- **Auto Port Detection**: Server automatically uses the port from your redirect URI
- **Custom Paths**: Use any callback path (not just `/oauth2callback`)
- **HTTPS Support**: Works with production HTTPS domains
- **Flexible Configuration**: Command line args override environment variables

### Custom Token Storage
```bash
export GMAIL_TOKEN_DIR="/custom/path/to/tokens"
npx gmail-mcp-server@latest
```

### Non-Interactive Mode
```bash
npx gmail-mcp-server@latest --non-interactive --client-id "id" --client-secret "secret"
```

### Reset Authentication
```bash
npx gmail-mcp-server@latest --reset-auth
```

## 📚 API Reference

### Email Operations
- **All operations support both single-user and multi-user modes**
- **Multi-user operations require `userId` parameter**
- **Comprehensive error handling and validation**
- **Support for international characters and attachments**

### Draft Operations
- **Complete draft lifecycle management**
- **Create, read, update, delete, and send drafts**
- **Full content preservation including attachments**
- **Seamless integration with email workflow**

### Search Capabilities  
- **Gmail search syntax support** (`is:unread`, `has:attachment`, etc.)
- **Date range filtering** (`after:2024/01/01`, `before:2024/12/31`)
- **Advanced filters** (sender, recipient, subject, labels)
- **Pagination support** for large result sets
- **Label-based organization** (INBOX, SENT, DRAFT, TRASH, SPAM)

### Authentication Features
- **On-demand authentication** - No upfront auth required
- **Automatic token refresh** - Seamless credential management  
- **Multi-account support** - Handle multiple Gmail accounts
- **Secure token storage** - Local encrypted credential storage
- **Manual/automatic modes** - Flexible authentication options

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details.

## 🆘 Support

- **Issues**: [GitHub Issues](https://github.com/yourusername/gmail-mcp-server/issues)
- **Documentation**: Check README.md and setup guides
- **Latest Version**: Always use `@latest` tag for newest features

---

**📧 Happy emailing with SIYA/Claude Desktop!** 🚀 