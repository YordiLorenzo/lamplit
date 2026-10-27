// @ts-check
// The page's side of the contract with Lamplit's Rust core: every command it calls (src-tauri/src/commands.rs) and
// every event it listens to (events.rs), with the shapes of their payloads. Nothing else in ui/ names a command or
// an event.

const tauri = /** @type {any} */ (window).__TAURI__;

/**
 * @typedef {'steam' | 'epic' | 'ea' | 'ubisoft' | 'rockstar' | 'battlenet' | 'gog' | 'amazon' | 'itch' | 'xbox'} StoreKey
 */

/**
 * Local paths of a game's art files.
 * @typedef {object} Art
 * @property {string | null} portrait
 * @property {string | null} hero
 * @property {string | null} logo
 */

/**
 * The art the player chose for a game: a Steam app's, or none (the cover shows the name).
 * @typedef {{ steam: number } | 'none'} ArtChoice
 */

/**
 * @typedef {object} Game
 * @property {string} id
 * @property {string} name
 * @property {StoreKey | null} store  null for a game outside any store
 * @property {string} dir  the install folder
 * @property {string | null} note  "Installing" or "Update pending", from the store
 * @property {number} last_played  Unix seconds, 0 for never
 * @property {number} play_minutes  Steam's count for a Steam game when it is more, else Lamplit's
 * @property {boolean} favourite  comes first in the row
 * @property {boolean} hidden  left out of the row; Settings lists it
 * @property {Art} art
 * @property {ArtChoice | null} art_choice  null: Lamplit's own match
 * @property {boolean} manual  added by hand, so it can be removed again
 * @property {StoreKey[]} requires  store apps that must run and be signed in for the game
 */

/**
 * A match on Steam's store for Change art, with its cover when Steam has one.
 * @typedef {object} ArtCandidate
 * @property {number} appid
 * @property {string} name
 * @property {string | null} portrait
 */

/**
 * An installed program that isn't in the library, for Add a game.
 * @typedef {object} Program
 * @property {string} name
 * @property {string} exe
 * @property {string} folder
 */

/**
 * A folder of the PC, for Add a game. With no path, it lists the drives.
 * @typedef {object} Folder
 * @property {string | null} path
 * @property {string | null} parent  null at a drive's root: back goes to the drives
 * @property {FolderEntry[]} entries  folders first, then exes
 */

/**
 * @typedef {object} FolderEntry
 * @property {string} name
 * @property {string} path
 * @property {'drive' | 'folder' | 'exe'} kind
 * @property {string | null} title  for an exe, the name its game would get
 */

/**
 * A store app, installed or not.
 * @typedef {object} StoreStatus
 * @property {StoreKey} store
 * @property {string} name  e.g. "EA app"
 * @property {boolean} installed
 * @property {boolean} running
 * @property {'signed-in' | 'remembered' | 'signed-out' | 'unknown'} account
 */

/**
 * @typedef {object} Overlays
 * @property {boolean} nvidia_overlay  the NVIDIA overlay is installed
 * @property {boolean | null} nvidia_stats  null when the overlay isn't installed or its log doesn't say
 */

/**
 * @typedef {object} Quiet
 * @property {'on' | 'off' | 'partly'} state
 * @property {boolean} active  the player has quiet mode on, so switching it off restores what it replaced
 * @property {string[]} notes  what couldn't be changed right now, for the player
 */

/**
 * @typedef {object} Setup
 * @property {boolean} needed
 */

/**
 * @typedef {object} Device
 * @property {string} id
 * @property {string} windows_name
 * @property {string} name  the short name Lamplit shows
 * @property {'tv' | 'headset' | 'controller' | 'other'} kind
 * @property {boolean} default
 */

/**
 * @typedef {object} Sound
 * @property {Device[]} outputs
 * @property {Device[]} inputs
 * @property {number | null} volume  of the default output, 0 to 100
 * @property {boolean | null} muted
 * @property {boolean | null} mic_muted
 */

/** @typedef {'battery' | 'charging' | 'full' | 'not-charging'} Charge */

/**
 * @typedef {object} Headset
 * @property {boolean} receiver  the receiver is plugged in
 * @property {boolean | null} on  null until Lamplit knows
 * @property {number | null} battery
 * @property {Charge | null} charge
 * @property {number | null} sidetone  0 to 100, null when the headset doesn't offer it
 * @property {number | null} auto_off  minutes, 0 for never, null when it can't be changed here
 */

/**
 * What kind of controller: a DualSense (read over HID, with its headphone jack and touchpad), another PlayStation
 * controller, an Xbox controller or one that works like one, or any other.
 * @typedef {'dualsense' | 'playstation' | 'xbox' | 'other'} PadKind
 */

/** @typedef {'empty' | 'low' | 'medium' | 'full'} BatteryLevel */

/**
 * A controller's battery: the percent and charge state, or only a rough level (Xbox-style controllers).
 * @typedef {object} PadBattery
 * @property {number | null} percent
 * @property {BatteryLevel | null} level
 * @property {Charge | null} charge
 */

/**
 * @typedef {object} Controller
 * @property {string} id
 * @property {PadKind} kind
 * @property {string} name  e.g. "DualSense", "Xbox controller", or the name Windows gives it
 * @property {'usb' | 'bluetooth' | 'wireless'} connection  wireless: Bluetooth or Microsoft's adapter
 * @property {PadBattery | null} battery  null while the controller reports none over this link
 * @property {boolean | null} headphones  a DualSense's jack, once a full report came; null for other controllers
 */

/**
 * @typedef {object} Accessories
 * @property {Headset} headset
 * @property {Controller[]} controllers
 */

/**
 * The player's choices on the Settings screen.
 * @typedef {object} Prefs
 * @property {boolean} sound_follows  sound follows the headset and controller headphones
 * @property {boolean} touchpad_mouse
 * @property {boolean} steam_devtools  Lamplit opens Steam's DevTools port (the PS button guard and Steam's pop-ups)
 * @property {boolean} online_art  art comes from Steam's store too
 * @property {number} screensaver_minutes  minutes without input before the screensaver, 0 for never
 * @property {boolean} dock  holding PS over a game opens the dock rather than the home screen
 */

/**
 * What became of a launched game. `up`: its window is up, and gets the screen once the starting screen has faded to
 * black; `running` follows once it has it. `starting`: it closed within 20 s of starting (a launcher handing over to
 * the game, or a crash at start), and Lamplit waits for it to come back.
 * @typedef {{ state: 'up' | 'running' | 'starting' | 'ended', id: string } | { state: 'failed', id: string, message: string }} Play
 */

/**
 * One line of the starting screen. A newer step with the same key replaces the line.
 * @typedef {object} LaunchStep
 * @property {string} id  the game being launched
 * @property {string} key
 * @property {'busy' | 'ok' | 'warn' | 'block' | 'error'} state  block: the player has to act
 * @property {string} label
 * @property {StoreKey | null} store  the store app the line is about
 */

/**
 * The game the dock is over.
 * @typedef {object} DockGame
 * @property {string} id
 * @property {string} name
 * @property {Art} art  its cover, background and logo
 * @property {number} started  when this session started, Unix seconds; 0 when Lamplit doesn't know
 * @property {number} session  this launch of the game, which a close names
 * @property {boolean} responding  its window answers Windows
 * @property {boolean} closable  Lamplit knows which processes are the game's, so the dock can close it
 * @property {boolean} force_close  the dock offers to end it: not responding, no window, or asked to close a while ago
 */

/** @typedef {'headset' | 'controller'} DockIcon */

/** Cross let go after a press, which only the dock hears of: its Close game asks for Cross to be held. @typedef {'ok-up'} DockRelease */

/**
 * What the dock shows: open over the game, folded away, or news for a moment in the folded pill.
 * @typedef {{ mode: 'open' } | { mode: 'closed' } | { mode: 'status', icon: DockIcon, text: string, warn: boolean }} DockShow
 */

/** @typedef {'left' | 'right' | 'up' | 'down' | 'l1' | 'r1' | 'ok' | 'back' | 'menu' | 'triangle' | 'square'} Action */

/**
 * How a failed command reaches the page.
 * @typedef {object} CommandError
 * @property {string} kind  "player" for a message written for the player, "internal" for one written for the log, else
 *   the part that failed
 * @property {string} message  what the player reads
 */

/**
 * Lines for lamplit.log, through tauri-plugin-log.
 * @type {{ info(message: string): Promise<void>, warn(message: string): Promise<void>, error(message: string): Promise<void> }}
 */
export const log = tauri.log;

/**
 * Lamplit's commands fail with a CommandError. Tauri's own failures (an unknown command, arguments that don't fit)
 * arrive as a plain string and get the same shape. Every failure is logged, since the page shows at most a toast.
 * @param {string} cmd
 * @param {Record<string, unknown>} [args]
 * @returns {Promise<any>}
 */
async function call(cmd, args) {
  try {
    return await tauri.core.invoke(cmd, args);
  } catch (e) {
    const error = typeof e === 'string' ? { kind: 'tauri', message: e } : e;
    log.warn(`${cmd} failed: ${error.message}`);
    throw error;
  }
}

/** The URL the page loads a local file from, through Tauri's asset protocol. @param {string} path */
export const assetUrl = (path) => /** @type {string} */ (tauri.core.convertFileSrc(path));

// ---------- commands ----------

/** @returns {Promise<Game[] | null>} null until the first scan has finished */
export const libraryGames = () => call('library_games');
/** @returns {Promise<void>} */
export const libraryRescan = () => call('library_rescan');
/** @param {string} id @param {boolean} on @returns {Promise<Game[]>} every game, with the change */
export const librarySetFavourite = (id, on) => call('library_set_favourite', { id, on });
/** @param {string} id @param {boolean} on @returns {Promise<Game[]>} every game, with the change */
export const librarySetHidden = (id, on) => call('library_set_hidden', { id, on });
/** What Steam's store has for `query`. @param {string} query @returns {Promise<ArtCandidate[]>} */
export const libraryArtSearch = (query) => call('library_art_search', { query });
/**
 * The art the player chose, null for Lamplit's own match.
 * @param {string} id @param {ArtChoice | null} choice @returns {Promise<Game[]>} every game, with the change
 */
export const librarySetArt = (id, choice) => call('library_set_art', { id, choice });
/** @returns {Promise<Program[]>} the installed programs that aren't in the library, A to Z */
export const libraryPrograms = () => call('library_programs');
/** @param {string | null} path  null for the drives @returns {Promise<Folder>} */
export const libraryBrowse = (path) => call('library_browse', { path });
/** @param {string} exe @param {string} name @returns {Promise<{ id: string, games: Game[] }>} its id, and every game */
export const libraryAddGame = (exe, name) => call('library_add_game', { exe, name });
/** A game added by hand leaves the library. @param {string} id @returns {Promise<Game[]>} every game */
export const libraryRemoveGame = (id) => call('library_remove_game', { id });
/** Starts the launch checks, which report through onLaunchStep and onPlay. @param {string} id @returns {Promise<void>} */
export const launchStart = (id) => call('launch_start', { id });
/** @returns {Promise<void>} */
export const launchAnyway = () => call('launch_anyway');
/** @returns {Promise<void>} */
export const launchCancel = () => call('launch_cancel');
/**
 * Shows the player what the launch may be waiting for: the window a "window" step points at, else the store app's
 * window. Lamplit stops holding the screen meanwhile.
 * @param {StoreKey | null} store @returns {Promise<void>}
 */
export const launchShow = (store) => call('launch_show', { store });
/** Brings the running game back to the front. @returns {Promise<void>} */
export const launchResume = () => call('launch_resume');
/** @returns {Promise<string | null>} the id of the game Lamplit waits on to close */
export const launchRunning = () => call('launch_running');
/** The game the dock is over. @returns {Promise<DockGame | null>} */
export const dockState = () => call('dock_state');
/**
 * Where the dock's island rests in its window, in pixels, and the radius of its corners.
 * @typedef {{ x: number, y: number, width: number, height: number, radius: number }} DockIsland
 */
/** Real glass under the island where it rests, or with null none. @param {DockIsland | null} island @returns {Promise<boolean>} true when it shows */
export const dockGlass = (island) => call('dock_glass', { island });
/** Folds the dock away, back to the game. @returns {Promise<void>} */
export const dockResume = () => call('dock_resume');
/** The home screen, in place of the dock. @returns {Promise<void>} */
export const dockHome = () => call('dock_home');
/**
 * Asks the game the dock shows to close, or ends it; Rust refuses when another game or session runs now.
 * @param {boolean} force @param {string} id @param {number} session @returns {Promise<void>}
 */
export const dockCloseGame = (force, id, session) => call('dock_close_game', { force, id, session });
/** @returns {Promise<StoreStatus[]>} */
export const storesStatus = () => call('stores_status');
/** Shows a store app so the player can sign in or deal with an update. @param {StoreKey} store @returns {Promise<void>} */
export const storesOpen = (store) => call('stores_open', { store });
/** @returns {Promise<Overlays>} */
export const overlayState = () => call('overlay_state');
/** @returns {Promise<boolean | null>} whether the stats show now */
export const overlayToggleStats = () => call('overlay_toggle_stats');
/** @returns {Promise<Quiet>} */
export const quietState = () => call('quiet_state');
/** @param {boolean} on @returns {Promise<Quiet>} */
export const quietSet = (on) => call('quiet_set', { on });
/** @returns {Promise<Setup>} */
export const setupState = () => call('setup_state');
/**
 * Asks Windows for admin rights once and runs the first-time setup. Returns once the prompt is answered; onSetup
 * follows when setup has ended.
 * @returns {Promise<void>}
 */
export const setupStart = () => call('setup_start');
/** @returns {Promise<Sound>} */
export const soundState = () => call('sound_state');
/** Makes a device the default output or microphone. @param {string} id @returns {Promise<Sound>} */
export const soundSetDefault = (id) => call('sound_set_default', { id });
/** @param {number} delta @returns {Promise<number>} the new volume */
export const soundChangeVolume = (delta) => call('sound_change_volume', { delta });
/** @param {boolean} mic @param {boolean} muted @returns {Promise<void>} */
export const soundSetMute = (mic, muted) => call('sound_set_mute', { mic, muted });
/** @returns {Promise<Accessories>} */
export const accessoriesState = () => call('accessories_state');
/**
 * Waits for the headset to take the setting.
 * @param {'sidetone' | 'auto-off'} setting
 * @param {number} value
 * @returns {Promise<Headset>} what the headset reads back
 */
export const headsetSet = (setting, value) => call('headset_set', { setting, value });
/** @param {string} id @returns {Promise<void>} */
export const controllerTurnOff = (id) => call('controller_turn_off', { id });
/** @returns {Promise<PadKind | null>} the kind of controller used last, null before any was */
export const controllerKind = () => call('controller_kind');
/** @returns {Promise<Prefs>} */
export const prefsState = () => call('prefs_state');
/** @param {boolean} on @returns {Promise<Prefs>} */
export const prefsSetSoundFollows = (on) => call('prefs_set_sound_follows', { on });
/** @param {boolean} on @returns {Promise<Prefs>} */
export const prefsSetTouchpadMouse = (on) => call('prefs_set_touchpad_mouse', { on });
/** Steam opens its DevTools port from its next start, or doesn't. @param {boolean} on @returns {Promise<Prefs>} */
export const prefsSetSteamDevtools = (on) => call('prefs_set_steam_devtools', { on });
/** @param {boolean} on @returns {Promise<Prefs>} */
export const prefsSetOnlineArt = (on) => call('prefs_set_online_art', { on });
/** @param {number} minutes 0 for never @returns {Promise<Prefs>} */
export const prefsSetScreensaverMinutes = (minutes) => call('prefs_set_screensaver_minutes', { minutes });
/** @param {boolean} on @returns {Promise<Prefs>} */
export const prefsSetDock = (on) => call('prefs_set_dock', { on });
/** @returns {Promise<void>} once the PC has woken up again */
export const powerSleep = () => call('power_sleep');
/** @returns {Promise<void>} once Windows has started to restart */
export const powerRestart = () => call('power_restart');
/** @returns {Promise<void>} once Windows has started to shut down */
export const powerShutDown = () => call('power_shut_down');
/** @returns {Promise<string | null>} e.g. "3840 × 2160 at 120 Hz" */
export const displayMode = () => call('display_mode');

// ---------- events ----------

/**
 * @template T
 * @param {string} name
 * @param {(payload: T) => void} handle
 * @returns {Promise<unknown>}
 */
const on = (name, handle) => tauri.event.listen(name, (/** @type {{ payload: T }} */ e) => handle(e.payload));

/** The library changed. @param {(games: Game[]) => void} handle */
export const onGames = (handle) => on('games', handle);
/** Art for one game came in. @param {(update: { id: string, art: Art }) => void} handle */
export const onArt = (handle) => on('art', handle);
/** A controller press while Lamplit is in front. @param {(action: Action) => void} handle */
export const onPad = (handle) => on('pad', handle);
/** Another kind of controller than before was used: the hints show its buttons. @param {(kind: PadKind) => void} handle */
export const onPadKind = (handle) => on('pad-kind', handle);
/** @param {(play: Play) => void} handle */
export const onPlay = (handle) => on('play', handle);
/** A controller brought Lamplit forward. @param {(runningId: string | null) => void} handle */
export const onSummoned = (handle) => on('summoned', handle);
/** The dock opens, folds away, or shows news. @param {(show: DockShow) => void} handle */
export const onDock = (handle) => on('dock', handle);
/** A controller press while the dock is open, or Cross let go. @param {(action: Action | DockRelease) => void} handle */
export const onDockPad = (handle) => on('dock-pad', handle);
/** @param {(step: LaunchStep) => void} handle */
export const onLaunchStep = (handle) => on('launch-step', handle);
/** @param {(stores: StoreStatus[]) => void} handle */
export const onStores = (handle) => on('stores', handle);
/** The headset, a controller or the sound device changed; accessoriesState and soundState have the news. @param {() => void} handle */
export const onAccessories = (handle) => on('accessories', handle);
/** A short message for the player. @param {(text: string) => void} handle */
export const onNotice = (handle) => on('notice', handle);
/** Setup started from Settings has ended. @param {(setup: Setup) => void} handle */
export const onSetup = (handle) => on('setup', handle);
