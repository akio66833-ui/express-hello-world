const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(cors());
app.use(express.json());

// Storage directories
const BOTS_DIR = './user_bots';
const BOTS_DB = './bots.json';

// Initialize storage
if (!fs.existsSync(BOTS_DIR)) {
  fs.mkdirSync(BOTS_DIR, { recursive: true });
}

if (!fs.existsSync(BOTS_DB)) {
  fs.writeFileSync(BOTS_DB, JSON.stringify({}));
}

// Helper functions
function loadBots() {
  const data = fs.readFileSync(BOTS_DB, 'utf8');
  return JSON.parse(data);
}

function saveBots(bots) {
  fs.writeFileSync(BOTS_DB, JSON.stringify(bots, null, 2));
}

// Store running processes
const runningProcesses = {};

// Configure multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const username = req.body.username;
    const userDir = path.join(BOTS_DIR, username);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }
    cb(null, userDir);
  },
  filename: (req, file, cb) => {
    const botId = `${req.body.username}_${req.body.bot_name}_${Date.now()}`.replace(/\s+/g, '_');
    const ext = path.extname(file.originalname);
    cb(null, `${botId}${ext}`);
  }
});

const upload = multer({ storage });

// ================================================================
// ROUTES
// ================================================================

app.get('/', (req, res) => {
  res.json({ status: 'Bot Hosting API is running' });
});

// Get user's bots
app.get('/api/bots/:username', (req, res) => {
  try {
    const { username } = req.params;
    const bots = loadBots();
    
    const userBots = Object.values(bots)
      .filter(bot => bot.username === username)
      .map(bot => ({
        ...bot,
        status: runningProcesses[bot.id] ? 'running' : 'stopped'
      }));
    
    res.json({ success: true, bots: userBots });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Upload bot
app.post('/api/bot/upload', upload.single('bot_file'), (req, res) => {
  try {
    const { username, bot_name } = req.body;
    const file = req.file;
    
    if (!username || !bot_name || !file) {
      return res.status(400).json({ 
        success: false, 
        message: 'Missing required fields' 
      });
    }
    
    const botId = path.basename(file.filename, path.extname(file.filename));
    const fileType = path.extname(file.filename).substring(1);
    
    const bots = loadBots();
    bots[botId] = {
      id: botId,
      name: bot_name,
      username: username,
      file_path: file.path,
      file_type: fileType,
      status: 'stopped',
      created_at: new Date().toISOString(),
      cpu: 0,
      memory: 0
    };
    
    saveBots(bots);
    
    res.json({ 
      success: true, 
      bot_id: botId, 
      message: 'Bot uploaded successfully' 
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Start bot
app.post('/api/bot/start/:botId', (req, res) => {
  try {
    const { botId } = req.params;
    const bots = loadBots();
    
    if (!bots[botId]) {
      return res.status(404).json({ success: false, message: 'Bot not found' });
    }
    
    if (runningProcesses[botId]) {
      return res.status(400).json({ success: false, message: 'Bot already running' });
    }
    
    const bot = bots[botId];
    const command = bot.file_type === 'py' ? 'python3' : 'node';
    
    const process = spawn(command, [bot.file_path]);
    
    process.stdout.on('data', (data) => {
      console.log(`[${botId}] ${data}`);
    });
    
    process.stderr.on('data', (data) => {
      console.error(`[${botId}] ERROR: ${data}`);
    });
    
    process.on('close', (code) => {
      console.log(`[${botId}] exited with code ${code}`);
      delete runningProcesses[botId];
    });
    
    runningProcesses[botId] = process;
    
    bot.status = 'running';
    bot.started_at = new Date().toISOString();
    saveBots(bots);
    
    res.json({ success: true, message: 'Bot started successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Stop bot
app.post('/api/bot/stop/:botId', (req, res) => {
  try {
    const { botId } = req.params;
    const bots = loadBots();
    
    if (!bots[botId]) {
      return res.status(404).json({ success: false, message: 'Bot not found' });
    }
    
    if (!runningProcesses[botId]) {
      return res.status(400).json({ success: false, message: 'Bot not running' });
    }
    
    runningProcesses[botId].kill();
    delete runningProcesses[botId];
    
    const bot = bots[botId];
    bot.status = 'stopped';
    bot.stopped_at = new Date().toISOString();
    saveBots(bots);
    
    res.json({ success: true, message: 'Bot stopped successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Delete bot
app.delete('/api/bot/delete/:botId', (req, res) => {
  try {
    const { botId } = req.params;
    const bots = loadBots();
    
    if (!bots[botId]) {
      return res.status(404).json({ success: false, message: 'Bot not found' });
    }
    
    // Stop if running
    if (runningProcesses[botId]) {
      runningProcesses[botId].kill();
      delete runningProcesses[botId];
    }
    
    // Delete file
    const bot = bots[botId];
    if (fs.existsSync(bot.file_path)) {
      fs.unlinkSync(bot.file_path);
    }
    
    delete bots[botId];
    saveBots(bots);
    
    res.json({ success: true, message: 'Bot deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get bot logs
app.get('/api/bot/logs/:botId', (req, res) => {
  try {
    const { botId } = req.params;
    const bots = loadBots();
    
    if (!bots[botId]) {
      return res.status(404).json({ success: false, message: 'Bot not found' });
    }
    
    const bot = bots[botId];
    let logs = `Bot: ${bot.name}\n`;
    logs += `Status: ${runningProcesses[botId] ? 'Running' : 'Stopped'}\n`;
    logs += `Created: ${bot.created_at}\n`;
    
    if (bot.started_at) {
      logs += `Last started: ${bot.started_at}\n`;
    }
    
    res.json({ success: true, logs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get bot status
app.get('/api/bot/status/:botId', (req, res) => {
  try {
    const { botId } = req.params;
    const bots = loadBots();
    
    if (!bots[botId]) {
      return res.status(404).json({ success: false, message: 'Bot not found' });
    }
    
    const bot = bots[botId];
    const isRunning = !!runningProcesses[botId];
    
    res.json({
      success: true,
      status: isRunning ? 'running' : 'stopped',
      cpu: bot.cpu || 0,
      memory: bot.memory || 0
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Bot Hosting API running on port ${PORT}`);
});
