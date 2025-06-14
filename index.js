

require('dotenv').config(); // Load .env file
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { createLogger, format, transports } = require('winston');
const fs = require('fs');

// Initialize Winston logger

const winston = require('winston');

const logger = winston.createLogger({
  transports: [
    new winston.transports.Console(), // Only log to console
    // Remove or comment out the file transport:
    // new winston.transports.File({ filename: 'logs/app.log' })
  ]
});


  transports: [
    new transports.Console(),
    new transports.File({ filename: 'logs/error.log', level: 'error' }),
    new transports.File({ filename: 'logs/combined.log' })
  ]
});

const app = express();
const server = createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// في بداية الملف بعد تعريف supabase

// بعد تعريف app.use(express.static(...))
//const apiRoutes = require('./routes/api');
//const { CONFIG_FILES } = require('next/dist/shared/lib/constants');
//app.use('/api', apiRoutes);

const sessions = new Map();
const qrcodes = new Map();

// Initialize Supabase
let supabase;
try {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    logger.info('Supabase client initialized successfully');
} catch (err) {
    logger.error('Failed to initialize Supabase client:', err);
    process.exit(1);
}

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.get('/', (req, res) => {
    try {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    } catch (err) {
        logger.error(`Failed to load index page: ${err.message}`);
        res.status(500).send('Internal Server Error');
    }
});
app.use(express.urlencoded({ extended: true }));
app.get('/api/allsessions', async (req, res) => {
    try {
        const activeSessions = await getActiveSessions();
        res.json(activeSessions);
    } catch (error) {
        logger.error('Error getting active sessions:', error);
        res.status(500).json({ error: 'Failed to retrieve active sessions' });
    }
});

app.get('/status', (req, res) => {
    res.json({
        Sessions: sessions.size,
        memoryUsage: process.memoryUsage(),
        uptime: process.uptime()
    }); 
});
// Socket.io events
io.on('connection', (socket) => {
    try {
        const currentsessionId = socket.id;
        console.log(` session ${sessions}`);
      
       // socket.emit(`currentsessionId: ${socket.id}`);
       
     
        socket.emit('currentsessionId', socket.id);

        socket.on('create_session', async (sessionId) => {
            try {

                console.log(` session ${sessions}`);
                if (!sessionId || typeof sessionId !== 'string') {
                    throw new Error('Invalid session ID provided');
                }

                if (sessions.has(sessionId)) {
                    logger.info(`Existing session found in memory: ${sessionId}`);
                    const existingClient = sessions.get(sessionId);
                    
                    if (existingClient.info) {
                        socket.emit('authenticated', { sessionId });
                        socket.emit('status', `Session ${sessionId} is already connected.`);
                        return;
                    } else {
                     await   existingClient.initialize();
                   //     await sessions.get(sessionId).initialize();
                        
                        
                        logger.info(`Session ${sessionId} exists but not connected. Reinitializing...`);
                    }
                }

           
                const client = new Client({
                    authStrategy: new LocalAuth({
                      dataPath: `./sessions/${sessionId}`
                    }),
                    puppeteer: {
                      headless: true,
                      args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-gpu',
                        '--single-process'
                      ],
                      executablePath: process.env.CHROME_PATH || 
                        (process.platform === 'win32' 
                          ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
                          : '/usr/bin/google-chrome')
                    }
                  });

                client.on('qr', async (qr) => {
                    try {
                        if (socket.connected){

                        
                        socket.emit('qr', { sessionId, qr });
                        socket.emit('status', 'Please scan the QR code for authentication...');
                        console.log(`QR code sent for session ${sessionId}`);
                    
                        qrcodes.set(sessionId, qr);
                    //  saveSession(sessionId);
                       
                    
                    
                    }

                        else{
                       // sessions.delete(sessionId);
                        //await deleteSession(sessionId);
                        }
                    } catch (err) {
                        logger.error('QR generation failed:', err);
                        socket.emit('error', { message: 'Failed to generate QR' });
                    }
                });

                client.on('authenticated', async() => {
                    try {
                       
                       const clientinfo=client.info();
                        saveClientInfo(sessionId, client.info)
                                .then(() => {
                                    socket.emit('authenticated', { clientinfo });
                                })

                    } catch (err) {
                        logger.error(`Error in authenticated event for ${sessionId}:`, err);
                        await deleteSessionFolder(sessionId);
                    }
                });

                client.on('ready', () => {
                    try {
                        logger.info(`Client ready: ${sessionId}`);
                        if (client.info) {
                            saveClientInfo(sessionId, client.info)
                                .then(() => {
                                    socket.emit('authenticated', { sessionId });
                                })
                                .catch(err => {
                                    logger.error('Client info save error:', err);
                                    socket.emit('error', {
                                        message: 'Failed to save client info',
                                        details: err.message
                                    });
                                });
                        }
                    } catch (err) {
                        logger.error(`Error in ready event for ${sessionId}:`, err);
                    }
                });

                // client.on('auth_failure', async (msg) => {
                //     try {
                //         logger.error(`Auth failure for session ${sessionId}: ${msg}`);
                //         socket.emit('error', { message: `Authentication failed: ${msg}` });
                //         socket.emit('status', 'Authentication failed, please try scanning QR again.');
                //         sessions.delete(sessionId);
                //         await deleteSession(sessionId);
                //         if (client.destroy) await client.destroy();
                //     } catch (err) {
                //         logger.error(`Error handling auth_failure for ${sessionId}:`, err);
                //     }
                // });

                // client.on('disconnected', async (reason) => {
                //     try {
                //         logger.info(`Session ${sessionId} disconnected: ${reason}`);
                //         socket.emit('status', `Disconnected: ${reason}`);
                //         socket.emit('disconnected', { sessionId, reason });
                //         sessions.delete(sessionId);
                //         await deleteSession(sessionId);
                //         if (client.destroy) await client.destroy();
                //     } catch (err) {
                //         logger.error(`Error handling disconnect for ${sessionId}:`, err);
                //     }
                // });

                await client.initialize();
                sessions.set(sessionId, client);
                logger.info(`Client initialization requested for session: ${sessionId}`);
            } catch (initErr) {
                logger.error(`Failed to initialize client for session ${sessionId}:`, initErr.message);
                socket.emit('error', { message: `Client initialization failed: ${initErr.message}` });
            }
        });

        socket.on('regenerate_qr', async (sessionId) => {
            try {
                const client = sessions.get(sessionId);
                if (!client) {
                    throw new Error('Session does not exist for QR regeneration');
                }
                if (client.info) {
                    throw new Error('Client is already connected');
                }

                await client.destroy();
                sessions.delete(sessionId);
                socket.emit('status', `Regenerating QR for ${sessionId}...`);
                await io.sockets.in(socket.id).emit('create_session', sessionId);
            } catch (err) {
                logger.error(`Failed to regenerate QR for session ${sessionId}:`, err);
                socket.emit('error', { message: err.message || 'Failed to regenerate QR' });
            }
        });

        socket.on('send_message', async ({ sessionId, phoneNumber, message }, callback) => {
            try {
                if (!sessionId || !phoneNumber || !message) {
                    throw new Error('Missing required parameters');
                }

                const client = sessions.get(sessionId);
                if (!client || !client.info) {
                    throw new Error('Session does not exist or is not authenticated');
                }

                const number = phoneNumber.includes('@c.us') ? phoneNumber : `${phoneNumber}@c.us`;
                const result = await client.sendMessage(number, message);
                logger.info(`Message sent from ${sessionId} to ${number}`);
                callback({ success: true, id: result.id._serialized });
            } catch (err) {
                logger.error(`Message send error for session ${sessionId}:`, err);
                callback({ success: false, error: err.message || 'Failed to send message' });
            }
        });

        socket.on('delete_session', async (sessionId) => {
            try {
                if (!isValidSessionId(sessionId)) {
                    throw new Error('Invalid session ID format');
                }

                const client = sessions.get(sessionId);
                const promises = [];
                
                if (client) {
                 //   promises.push(client.destroy().catch(e => logger.error('Client destroy error:', e)));
                    sessions.delete(sessionId);
                }
                
                promises.push(
                    deleteSession(sessionId).catch(e => logger.error('DB delete error:', e)),
                    deleteSessionFolder(sessionId).catch(e => logger.error('Folder delete error:', e))
                );
                
                await Promise.all(promises);
                socket.emit('session_deleted', { success: true, sessionId });
            } catch (err) {
                logger.error(`Full deletion failed for ${sessionId}:`, err);
                socket.emit('session_deleted', { 
                    success: false, 
                    sessionId,
                    error: err.message 
                });
            }
        });

        socket.on('disconnect', (reason) => {
            try {
                logger.info(`Disconnected: ${socket.id} (Reason: ${reason})`);
                sessions.forEach((client, sessionId) => {
                    if (!client.info) {
                    //    client.destroy().catch(err => logger.error(`Error destroying client ${sessionId}:`, err));
                    //    sessions.delete(sessionId);
                    }
                });
            } catch (err) {
                logger.error('Error in disconnect handler:', err);
            }
        });

    } catch (err) {
        logger.error('Error in socket connection handler:', err);
    }
});

// Helper functions
function isValidSessionId(sessionId) {
    return /^[a-zA-Z0-9_-]+$/.test(sessionId);
}

async function deleteSessionFolder2(sessionId) {
    try {
        const sessionPath = path.join(__dirname, 'sessions', sessionId);
        
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            logger.info(`Session folder deleted: ${sessionPath}`);
            return true;
        }
        
        logger.info(`Session folder not found: ${sessionPath}`);
        return false;
    } catch (err) {
        logger.error(`Error deleting session folder ${sessionId}:`, err);
        throw err;
    }
}




async function deleteSessionFolder(sessionId) {
    const sessionPath = path.join(sessionsDir, sessionId);
    
    if (!fs.existsSync(sessionPath)) {
        console.log(`[INFO] Folder not found: ${sessionPath}`);
        return false;
    }

    try {
        // إغلاق العميل أولاً إذا كان موجوداً
        const client = sessions.get(sessionId);
        if (client) {
          //  await client.destroy();
            //sessions.delete(sessionId);
        }

        // حذف المجلد مع إعادة المحاولة
        await fs.promises.rm(sessionPath, { 
            recursive: false, 
            force: true,
            maxRetries: 3,
            retryDelay: 100
        });
        
        console.log(`[SUCCESS] Deleted session folder: ${sessionPath}`);
        return true;
    } catch (err) {
        console.error(`[ERROR] Failed to delete ${sessionPath}:`, err);
        
        // حاول باستخدام طريقة بديلة إذا فشلت
        try {
            await exec(`rm -rf "${sessionPath}"`); // للأنظمة الشبيهة بيونكس
            return true;
        } catch (fallbackErr) {
            console.error(`[FALLBACK ERROR] Also failed:`, fallbackErr);
            throw err; // أعد رمي الخطأ الأصلي
        }
    }
}


async function saveSession(sessionId) {
    try {
       
        const { error } = await supabase
            .from('sessions_whatsapp')
            .upsert({
                session_id: sessionId,
                client_info: sessions.get(sessionId).Client.info,
                session_data: qrcodes.get(sessionId),
                updated_at: new Date().toISOString()
                
            }, {
                onConflict: 'session_id',
                returning: 'minimal'
            });

        if (error) throw error;
        logger.info(`Session data saved/updated: ${sessionId}`);
    } catch (err) {
        logger.error(`Failed to save session data for ${sessionId}:`, err.message);
        throw err;
    }
}

async function saveClientInfo(sessionId, clientInfo) {
    try {
        if (!clientInfo) {
            logger.warn(`No client info provided for session: ${sessionId}`);
            return;
        }

        const { error } = await supabase
            .from('sessions_whatsapp')
            .upsert({
                session_id: sessionId,
                client_info: clientInfo,
                session_data: qrcodes.get(sessionId),
                updated_at: new Date().toISOString()
            }, {
                onConflict: 'session_id',
                returning: 'minimal'
            });

        if (error) throw error;
        logger.info(`Client info saved/updated for session: ${sessionId}`);
    } catch (err) {
        logger.error(`Failed to save client info for ${sessionId}:`, err.message);
        throw err;
    }
}
async function deleteSessionFolder(sessionId) {
    try {
        
      const sessionPath = path.join(__dirname, 'sessions', sessionId);
      if (fs.existsSync(sessionPath)) {
      //  fs.rmSync(sessionPath, { recursive: true, force: true });
        logger.info(`Session folder deleted: ${sessionPath}`);
        return true;
      }
      return false;
    } catch (err) {
      logger.error(`Error deleting session folder ${sessionId}:`, err);
      throw err;
    }
  }


async function getSession(sessionId) {
    try {
        const { data, error } = await supabase
            .from('sessions_whatsapp')
            .select('session_data')
            .eq('session_id', sessionId)
            .maybeSingle();

        if (error) {
            if (error.code === 'PGRST116') {
                return null;
            }
            throw error;
        }
        return data ? data.session_data : null;
    } catch (err) {
        deleteSession(sessionId);
        logger.error(`Failed to load session ${sessionId} from DB:`, err);
        throw err;
    }
}



 async function loadActiveSessions() {
    try {
        const { data: activeSessions, error } =  await supabase
            .from('sessions_whatsapp')
            .select('session_id, session_data, client_info, updated_at, created_at')
           // .not('client_info', 'is', null)
            // Only load active sessions
         ;
        if (error) throw error;

        if (!activeSessions || activeSessions.length === 0) {
            logger.info('No active sessions found to load at startup.');
            console.log('No active sessions found to load at startup.');
            return;
        }



        logger.info(`Loading ${activeSessions.length} active sessions...`);
        console.log(`Loading ${activeSessions.length} active sessions...`);

        for (const session of activeSessions) {
            try {
                // Skip if session already exists and is connected
                if (sessions.has(session.session_id)) {
                    const existingClient = sessions.get(session.session_id);
                    if (existingClient && existingClient.info?.wid) {
                        logger.info(`Session ${session.session_id} is already connected. Skipping...`);
                        continue;
                    }
                }
                console.log(`Session ${session.session_id} is already connected. Skipping...`);
                const client = new Client({
                    session: session.session_data,
                    clientInfo: session.client_info,
                    authStrategy: new LocalAuth({
                        dataPath: `./sessions/${session.session_id}`
                    }),
                    puppeteer: {
                        args: ['--no-sandbox', '--disable-setuid-sandbox'],
                        headless: true
                    },
                    takeoverOnConflict: true,
                    restartOnAuthFail: true
                });

                // Setup event handlers
              //  setupClientEventHandlers(client, session);

                // Store references
                sessions.set(session.session_id, client);
                qrcodes.set(session.session_id, session.session_data); // Initialize with null QR code

                // Initialize the client
                 client.initialize();
                
            } catch (err) {
                logger.error(`Failed to initialize session ${session.session_id}: ${err.message}`);
             //   await handleSessionError(session.session_id, err);
            }
        }
    } catch (err) {
        logger.error(`General failure loading sessions at startup: ${err.message}`);
    }

}

  let listCommand = {}
const sessionsDir = path.join(__dirname, 'sessions');
// const readCommands = () => {
//     let dir = sessionsDir
//     let dirs = fs.readdirSync(dir)
//     let listType = []
  
//     try {
//         dirs.forEach(async (res) => {
//             let groups = res.toLowerCase()
//             Commands.type = dirs.filter(v => v !== "_").map(v => v)
//             listCommand[groups] = []
//             let files = fs.readdirSync(`${dir}/${res}`).filter((file) => file.endsWith(".js"))
//             for (const file of files) {
//                 const command = require(`${dir}/${res}/${file}`)
//                 let options = {
//                     name: command.name ? command.name : "",
//                     alias: command.alias ? command.alias : [],
//                     desc: command.desc ? command.desc : "",
//                     type: command.type ? command.type : "",
//                     example: command.example ? command.example : "",
//                     isMedia: command.isMedia ? command.isMedia : false,
//                     isOwner: command.isOwner ? command.isOwner : false,
//                     isGroup: command.isGroup ? command.isGroup : false,
//                     isPrivate: command.isPrivate ? command.isPrivate : false,
//                     isBotAdmin: command.isBotAdmin ? command.isBotAdmin : false,
//                     isAdmin: command.isAdmin ? command.isAdmin : false,
//                     isBot: command.isBot ? command.isBot : false,
//                     disable: command.disable ? command.disable : false,
//                     isQuery: command.isQuery ? command.isQuery : false,
//                     start: command.start ? command.start : () => {}
//                 }
//                 listCommand[groups].push(options)
//                 Commands.set(options.name, options)
//                 global.reloadFile(`${dir}/${res}/${file}`)
//             }
//         })
//         Commands.list = listCommand
//     } catch (e) {
//         console.error(e)
//     }
// }




// Start server



// جلب جميع الجلسات المحفوظة

if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir);
}

const sessionFiles = fs.readdirSync(sessionsDir);
// أضف في بداية التطبيق
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception:', err);
    // يمكنك اختيار إعادة التشغيل أو الخروج
    process.exit(1);
});
// تحميل كل جلسة
async function startApp() {
    try {
      await loadAllSessions();
      server.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
      });
    } catch (err) {
      console.error('Fatal startup error:', err);
      process.exit(1);
    }
  }
  
  startApp();

const PORT = process.env.PORT || 3001;
// server.listen(PORT, async() => {
//     logger.info(`Server running on http://localhost:${PORT}`);
//     logger.info(`WebSocket available at ws://localhost:${PORT}`);
//      console.log(`Server running on http://localhost:${PORT}`);
//     console.log(`WebSocket available at ws://localhost:${PORT}`);
//    //await loadActiveSessions().catch(err => logger.error('Error loading active sessions:', err));
//    await loadAllSessions();
//    printSessions();
//    // await loadAllSessionsFolder();
// });

// Process event handlers
// أضف هذه الدالة
async function safeDestroy(client, sessionId) {
    try {
        if (!client) return;
        
        // 1. Remove all listeners
        client.removeAllListeners();
        
        // 2. Close page if exists
        if (client.pupPage && !client.pupPage.isClosed()) {
            await client.pupPage.close().catch(() => {});
        }
        
        // 3. Destroy client
        await client.destroy().catch(() => {});
        
        // 4. Cleanup
        sessions.delete(sessionId);
        qrcodes.delete(sessionId);
        
        return true;
    } catch (err) {
        logger.error(`Force cleanup for ${sessionId}:`, err);
        return false;
    }
}

// عدل SIGINT handler
process.on('SIGINT', async () => {
    logger.info('Shutting down gracefully...');
    
    const cleanupResults = await Promise.all(
        Array.from(sessions.entries()).map(
            async ([id, client]) => ({
                sessionId: id,
                success: await safeDestroy(client, id)
            })
        )
    );
    
    server.close(() => {
        logger.info('Cleanup completed', cleanupResults);
        process.exit(0);
    });
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception:', err);
    process.exit(1);
});

app.post('/send/:sessionId',  async (req, res) => {
    try{
    const { sessionId } = req.params;
    let phoneNumber = req.query.phoneNumber;
    let message = req.query.message;
     
     
     if (!phoneNumber && !message) {
        message = req.body.message;
        phoneNumber = req.body.phoneNumber;
      }
    if (!phoneNumber || !message) {
      return res.status(400).json({ error: 'Phone number and message are required' });
    }
  
    const client = sessions.get(sessionId);
    if (!client) {

      return res.status(404).json({ error: 'Session not found' });
    }
    console.log("client.info:",client.info)
    if (!client.info) {
        console.log("client.info:",client.info)
        logger.info(`Destroying WhatsApp client for session ${sessionId}...`);
      //  await client.destroy();
    }
    
      const number = phoneNumber.includes('@c.us') ? phoneNumber : `${phoneNumber}@c.us`;
      const result = await client.sendMessage(number, message);
      res.json({ success: true, messageId: result.id._serialized });
    } catch (error) {
      res.status(500).json({ error: 'Failed to send message' + error });
    }
  });




// Assuming these are defined elsewhere in your code


async function loadAllSessionsFolder() {
    try {
        // Read session files from directory
        const sessionFiles = fs.readdirSync(sessionsDir);
        
        // Process each session file
        for (const sessionFile of sessionFiles) {
            try {
                const sessionId = sessionFile;
                const sessionPath = path.join(sessionsDir, sessionFile);
                
                // Skip if not a directory (session folders are typically directories)
                if (!fs.statSync(sessionPath).isDirectory()) {
                    continue;
                }

                const client = new Client({
                    authStrategy: new LocalAuth({
                        dataPath: sessionPath
                    }),
                    puppeteer: {
                        headless: true,
                        args: ['--no-sandbox', '--disable-setuid-sandbox']
                    }
                });

                client.on('ready', () => {
                    console.log(`✅ Session ${sessionId} is ready!`);
                //   qrcodes.delete(sessionId); // Remove QR code if it was stored
                });

                client.on('qr', qr => {
                    if (!client.connected) {
                        console.log(`❌ الاتصال مغلق لـ ${sessionId} - تنظيف الجلسة...`);
                        
                        // إجراءات التنظيف:
                        qrcodes.delete(sessionId);
                        sessions.delete(sessionId);
                      //  client.destroy();
                    //    deleteSessionFolder(sessionId);
                        // يمكنك أيضاً حذف مجلد الجلسة إذا أردت
                        // await deleteSessionFolder(sessionId);
                        
                        return;
                    }
                    
                    // إذا كان الاتصال نشطاً
                    qrcodes.set(sessionId, qr);
                    console.log(`🔑 Session ${sessionId} needs QR scan`);
                });

                client.on('auth_failure', () => {
                    console.log(`❌ Authentication failed for session ${sessionId}`);
                  //  client.destroy();
                    sessions.delete(sessionId);
                });

                client.on('disconnected', (reason) => {
                    console.log(`⚠️ Session ${sessionId} disconnected: ${reason}`);
                    sessions.delete(sessionId);
                });

                await client.initialize();
                sessions.set(sessionId, client);
                
            } catch (error) {
                console.error(`Error initializing session ${sessionFile}:`, error);
            }
        }
        
        console.log(`Loaded ${sessions.size} sessions successfully`);
    } catch (error) {
        console.error('Error loading sessions:', error);
    }
}

// Usage
//loadAllSessionsFolder();
function printSessions() {
    console.log('Current sessions:');
    sessions.forEach((client, sessionId) => {
        console.log(`- ${sessionId} (ready: ${!!client.info})`);
    });
}

// استبدل الدالتين بدالة واحدة محسنة
async function loadAllSessions() {
    try {
        // Load from database
        const { data: dbSessions } = await supabase
            .from('sessions_whatsapp')
            .select('session_id, session_data, client_info');
        
        // Load from filesystem
        const sessionFiles = fs.readdirSync(sessionsDir)
            .filter(file => fs.statSync(path.join(sessionsDir, file)).isDirectory());

        const loadedSessions = new Set();

        // Load database sessions first
        for (const session of dbSessions || []) {
            if (!sessions.has(session.session_id)) {
                await initializeSession(session.session_id, session);
                loadedSessions.add(session.session_id);
            }
        }

        // Load filesystem sessions
        for (const sessionFile of sessionFiles) {
            if (!loadedSessions.has(sessionFile)) {
                await initializeSession(sessionFile);
            }
        }
    } catch (err) {
        logger.error('Failed to load sessions:', err);
    }
}

async function initializeSession(sessionId, sessionData = null) {
    try {
        const client = new Client({
            authStrategy: new LocalAuth({
                dataPath: `./sessions/${sessionId}`
            }),
            puppeteer: {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            }
        });

        setupClientHandlers(client, sessionId);
        await client.initialize();
        sessions.set(sessionId, client);
        return true;
    } catch (err) {
        logger.error(`Failed to init session ${sessionId}:`, err);
        return false;
    }
}
