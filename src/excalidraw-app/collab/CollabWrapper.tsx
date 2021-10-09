import throttle from "lodash.throttle";
import React, { PureComponent } from "react";
import { AppState, ExcalidrawImperativeAPI } from "../../types";
import { ErrorDialog } from "../../components/ErrorDialog";
import { APP_NAME, ENV, EVENT } from "../../constants";
import { ImportedDataState } from "../../data/types";
import {
  ExcalidrawElement,
  InitializedExcalidrawImageElement,
} from "../../element/types";
import {
  getElementMap,
  getSceneVersion,
} from "../../packages/excalidraw/index";
import { Collaborator, Gesture } from "../../types";
import {
  preventUnload,
  resolvablePromise,
  withBatchedUpdates,
} from "../../utils";
import {
  APP_EVENTS,
  FILE_UPLOAD_MAX_BYTES,
  FIREBASE_STORAGE_PREFIXES,
  INITIAL_SCENE_UPDATE_TIMEOUT,
  LOAD_IMAGES_TIMEOUT,
  SCENE,
  SYNC_FULL_SCENE_INTERVAL_MS,
} from "../app_constants";
import {
  decryptAESGEM,
  generateCollaborationLinkData,
  getCollaborationLink,
  SocketUpdateDataSource,
  SOCKET_SERVER,
} from "../data";
import {
  isSavedToFirebase,
  loadFilesFromFirebase,
  loadFromFirebase,
  saveFilesToFirebase,
  saveToFirebase,
} from "../data/firebase";
import {
  importUsernameFromLocalStorage,
  saveUsernameToLocalStorage,
  STORAGE_KEYS,
} from "../data/localStorage";
import Portal from "./Portal";
import RoomDialog from "./RoomDialog";
import { createInverseContext } from "../../createInverseContext";
import { t } from "../../i18n";
import { UserIdleState } from "../../types";
import { IDLE_THRESHOLD, ACTIVE_THRESHOLD } from "../../constants";
import { trackEvent } from "../../analytics";
import { isInvisiblySmallElement } from "../../element";
import { FileSync } from "../data/FileSync";
import { AbortError } from "../../errors";
import {
  isImageElement,
  isInitializedImageElement,
} from "../../element/typeChecks";
import { mutateElement } from "../../element/mutateElement";

interface CollabState {
  modalIsShown: boolean;
  errorMessage: string;
  username: string;
  userState: UserIdleState;
  activeRoomLink: string;
}

type CollabInstance = InstanceType<typeof CollabWrapper>;

export interface CollabAPI {
  /** function so that we can access the latest value from stale callbacks */
  isCollaborating: () => boolean;
  username: CollabState["username"];
  userState: CollabState["userState"];
  onPointerUpdate: CollabInstance["onPointerUpdate"];
  initializeSocketClient: CollabInstance["initializeSocketClient"];
  onCollabButtonClick: CollabInstance["onCollabButtonClick"];
  broadcastElements: CollabInstance["broadcastElements"];
  fetchImageFilesFromFirebase: CollabInstance["fetchImageFilesFromFirebase"];
}

type ReconciledElements = readonly ExcalidrawElement[] & {
  _brand: "reconciledElements";
};

interface Props {
  excalidrawAPI: ExcalidrawImperativeAPI;
}

const {
  Context: CollabContext,
  Consumer: CollabContextConsumer,
  Provider: CollabContextProvider,
} = createInverseContext<{ api: CollabAPI | null }>({ api: null });

export { CollabContext, CollabContextConsumer };

class CollabWrapper extends PureComponent<Props, CollabState> {
  portal: Portal;
  fileSync: FileSync;
  excalidrawAPI: Props["excalidrawAPI"];
  isCollaborating: boolean = false;
  activeIntervalId: number | null;
  idleTimeoutId: number | null;

  private socketInitializationTimer?: number;
  private lastBroadcastedOrReceivedSceneVersion: number = -1;
  private collaborators = new Map<string, Collaborator>();

  constructor(props: Props) {
    super(props);
    this.state = {
      modalIsShown: false,
      errorMessage: "",
      username: importUsernameFromLocalStorage() || "",
      userState: UserIdleState.ACTIVE,
      activeRoomLink: "",
    };
    this.portal = new Portal(this);
    this.fileSync = new FileSync({
      getFiles: async (fileIds) => {
        const { roomId, roomKey } = this.portal;
        if (!roomId || !roomKey) {
          throw new AbortError();
        }

        return loadFilesFromFirebase(`files/rooms/${roomId}`, roomKey, fileIds);
      },
      saveFiles: async ({ addedFiles }) => {
        const { roomId, roomKey } = this.portal;
        if (!roomId || !roomKey) {
          throw new AbortError();
        }

        return saveFilesToFirebase({
          prefix: `${FIREBASE_STORAGE_PREFIXES.collabFiles}/${roomId}`,
          encryptionKey: roomKey,
          files: addedFiles,
          maxBytes: FILE_UPLOAD_MAX_BYTES,
        });
      },
    });
    this.excalidrawAPI = props.excalidrawAPI;
    this.activeIntervalId = null;
    this.idleTimeoutId = null;
  }

  componentDidMount() {
    window.addEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
    window.addEventListener(EVENT.UNLOAD, this.onUnload);

    if (
      process.env.NODE_ENV === ENV.TEST ||
      process.env.NODE_ENV === ENV.DEVELOPMENT
    ) {
      window.collab = window.collab || ({} as Window["collab"]);
      Object.defineProperties(window, {
        collab: {
          configurable: true,
          value: this,
        },
      });
    }
  }

  componentWillUnmount() {
    window.removeEventListener(EVENT.BEFORE_UNLOAD, this.beforeUnload);
    window.removeEventListener(EVENT.UNLOAD, this.onUnload);
    window.removeEventListener(EVENT.POINTER_MOVE, this.onPointerMove);
    window.removeEventListener(
      EVENT.VISIBILITY_CHANGE,
      this.onVisibilityChange,
    );
    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }
  }

  private onUnload = () => {
    this.destroySocketClient({ isUnload: true });
  };

  private beforeUnload = withBatchedUpdates((event: BeforeUnloadEvent) => {
    const syncableElements = this.getSyncableElements(
      this.getSceneElementsIncludingDeleted(),
    );

    if (
      this.isCollaborating &&
      (syncableElements.some(
        (element) =>
          isInitializedImageElement(element) &&
          !element.isDeleted &&
          element.status === "pending",
      ) ||
        !isSavedToFirebase(this.portal, syncableElements))
    ) {
      // this won't run in time if user decides to leave the site, but
      //  the purpose is to run in immediately after user decides to stay
      this.saveCollabRoomToFirebase(syncableElements);

      preventUnload(event);
    }

    if (this.isCollaborating || this.portal.roomId) {
      try {
        localStorage?.setItem(
          STORAGE_KEYS.LOCAL_STORAGE_KEY_COLLAB_FORCE_FLAG,
          JSON.stringify({
            timestamp: Date.now(),
            room: this.portal.roomId,
          }),
        );
      } catch {}
    }
  });

  saveCollabRoomToFirebase = async (
    syncableElements: ExcalidrawElement[] = this.getSyncableElements(
      this.excalidrawAPI.getSceneElementsIncludingDeleted(),
    ),
  ) => {
    try {
      await saveToFirebase(this.portal, syncableElements);
    } catch (error) {
      console.error(error);
    }
  };

  openPortal = async () => {
    trackEvent("share", "room creation");
    return this.initializeSocketClient(null);
  };

  closePortal = () => {
    this.saveCollabRoomToFirebase();
    if (window.confirm(t("alerts.collabStopOverridePrompt"))) {
      window.history.pushState({}, APP_NAME, window.location.origin);
      this.destroySocketClient();
      trackEvent("share", "room closed");

      window.dispatchEvent(new CustomEvent(APP_EVENTS.COLLAB_ROOM_CLOSE));

      const elements = this.excalidrawAPI
        .getSceneElementsIncludingDeleted()
        .map((element) => {
          if (isImageElement(element) && element.status !== "pending") {
            return mutateElement(element, { status: "pending" }, false);
          }
          return element;
        });

      this.excalidrawAPI.updateScene({
        elements,
        commitToHistory: false,
      });
    }
  };

  private destroySocketClient = (opts?: { isUnload: boolean }) => {
    if (!opts?.isUnload) {
      this.collaborators = new Map();
      this.excalidrawAPI.updateScene({
        collaborators: this.collaborators,
      });
      this.setState({
        activeRoomLink: "",
      });
      this.isCollaborating = false;
    }
    this.lastBroadcastedOrReceivedSceneVersion = -1;
    this.portal.close();
    this.fileSync.reset();
  };

  private fetchImageFilesFromFirebase = async (scene: {
    elements: readonly ExcalidrawElement[];
    appState: Pick<AppState, "files">;
  }) => {
    const unfetchedImages = scene.elements
      .filter((element) => {
        return (
          isInitializedImageElement(element) &&
          !this.fileSync.isFileHandled(element.fileId) &&
          !element.isDeleted &&
          element.status === "saved"
        );
      })
      .map((element) => (element as InitializedExcalidrawImageElement).fileId);

    const { loadedFiles, erroredFiles } = await this.fileSync.getFiles(
      unfetchedImages,
    );
    return {
      loadedFiles: loadedFiles
        .filter((file) => file.type === "image")
        .map(
          (file) =>
            ({
              ...file,
              type: "image",
            } as const),
        ),
      erroredFiles,
    };
  };

  private initializeSocketClient = async (
    existingRoomLinkData: null | { roomId: string; roomKey: string },
  ): Promise<ImportedDataState | null> => {
    if (this.portal.socket) {
      return null;
    }

    let roomId;
    let roomKey;

    if (existingRoomLinkData) {
      ({ roomId, roomKey } = existingRoomLinkData);
    } else {
      ({ roomId, roomKey } = await generateCollaborationLinkData());
      roomId = "5f08678972010ce89c50";
      roomKey = "u8x5c_6c--myu1ECtLadqw";
      window.history.pushState(
        {},
        APP_NAME,
        getCollaborationLink({ roomId, roomKey }),
      );
    }

    const scenePromise = resolvablePromise<ImportedDataState | null>();

    this.isCollaborating = true;

    const { default: socketIOClient }: any = await import(
      /* webpackChunkName: "socketIoClient" */ "socket.io-client"
    );

    this.portal.open(socketIOClient(SOCKET_SERVER), roomId, roomKey);

    if (existingRoomLinkData) {
      this.excalidrawAPI.resetScene();

      try {
        const elements = await loadFromFirebase(
          roomId,
          roomKey,
          this.portal.socket,
        );
        if (elements) {
          scenePromise.resolve({
            elements,
            scrollToContent: true,
          });
        }
      } catch (error) {
        // log the error and move on. other peers will sync us the scene.
        console.error(error);
      }
    } else {
      const elements = this.excalidrawAPI.getSceneElements().map((element) => {
        if (isImageElement(element) && element.status !== "pending") {
          return mutateElement(element, { status: "pending" }, false);
        }
        return element;
      });
      // remove deleted elements from elements array & history to ensure we don't
      // expose potentially sensitive user data in case user manually deletes
      // existing elements (or clears scene), which would otherwise be persisted
      // to database even if deleted before creating the room.
      this.excalidrawAPI.history.clear();
      this.excalidrawAPI.updateScene({
        elements,
        commitToHistory: true,
      });

      this.broadcastElements(elements);

      const syncableElements = this.getSyncableElements(elements);
      this.saveCollabRoomToFirebase(syncableElements);
    }

    // fallback in case you're not alone in the room but still don't receive
    // initial SCENE_UPDATE message
    this.socketInitializationTimer = window.setTimeout(() => {
      this.initializeSocket();
      scenePromise.resolve(null);
    }, INITIAL_SCENE_UPDATE_TIMEOUT);

    // All socket listeners are moving to Portal
    this.portal.socket!.on(
      "client-broadcast",
      async (encryptedData: ArrayBuffer, iv: Uint8Array) => {
        if (!this.portal.roomKey) {
          return;
        }
        const decryptedData = await decryptAESGEM(
          encryptedData,
          this.portal.roomKey,
          iv,
        );

        switch (decryptedData.type) {
          case "INVALID_RESPONSE":
            return;
          case SCENE.INIT: {
            if (!this.portal.socketInitialized) {
              this.initializeSocket();
              const remoteElements = decryptedData.payload.elements;
              const reconciledElements = this.reconcileElements(remoteElements);
              this.handleRemoteSceneUpdate(reconciledElements, {
                init: true,
              });
              // noop if already resolved via init from firebase
              scenePromise.resolve({
                elements: reconciledElements,
                scrollToContent: true,
              });
            }
            break;
          }
          case SCENE.UPDATE:
            this.handleRemoteSceneUpdate(
              this.reconcileElements(decryptedData.payload.elements),
            );
            break;
          case "MOUSE_LOCATION": {
            const {
              pointer,
              button,
              username,
              selectedElementIds,
            } = decryptedData.payload;
            const socketId: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["socketId"] =
              decryptedData.payload.socketId ||
              // @ts-ignore legacy, see #2094 (#2097)
              decryptedData.payload.socketID;

            const collaborators = new Map(this.collaborators);
            const user = collaborators.get(socketId) || {}!;
            user.pointer = pointer;
            user.button = button;
            user.selectedElementIds = selectedElementIds;
            user.username = username;
            collaborators.set(socketId, user);
            this.excalidrawAPI.updateScene({
              collaborators,
            });
            break;
          }
          case "IDLE_STATUS": {
            const { userState, socketId, username } = decryptedData.payload;
            const collaborators = new Map(this.collaborators);
            const user = collaborators.get(socketId) || {}!;
            user.userState = userState;
            user.username = username;
            this.excalidrawAPI.updateScene({
              collaborators,
            });
            break;
          }
        }
      },
    );

    this.portal.socket!.on("first-in-room", () => {
      if (this.portal.socket) {
        this.portal.socket.off("first-in-room");
      }
      this.initializeSocket();
      scenePromise.resolve(null);
    });

    this.initializeIdleDetector();

    this.setState({
      activeRoomLink: window.location.href,
    });

    return scenePromise;
  };

  private initializeSocket = () => {
    this.portal.socketInitialized = true;
    clearTimeout(this.socketInitializationTimer!);
  };

  private reconcileElements = (
    elements: readonly ExcalidrawElement[],
  ): ReconciledElements => {
    const currentElements = this.getSceneElementsIncludingDeleted();
    // create a map of ids so we don't have to iterate
    // over the array more than once.
    const localElementMap = getElementMap(currentElements);

    const appState = this.excalidrawAPI.getAppState();

    // Reconcile
    const newElements: readonly ExcalidrawElement[] = elements
      .reduce((elements, element) => {
        // if the remote element references one that's currently
        // edited on local, skip it (it'll be added in the next step)
        if (
          element.id === appState.editingElement?.id ||
          element.id === appState.resizingElement?.id ||
          element.id === appState.draggingElement?.id
        ) {
          return elements;
        }

        if (
          localElementMap.hasOwnProperty(element.id) &&
          localElementMap[element.id].version > element.version
        ) {
          elements.push(localElementMap[element.id]);
          delete localElementMap[element.id];
        } else if (
          localElementMap.hasOwnProperty(element.id) &&
          localElementMap[element.id].version === element.version &&
          localElementMap[element.id].versionNonce !== element.versionNonce
        ) {
          // resolve conflicting edits deterministically by taking the one with the lowest versionNonce
          if (localElementMap[element.id].versionNonce < element.versionNonce) {
            elements.push(localElementMap[element.id]);
          } else {
            // it should be highly unlikely that the two versionNonces are the same. if we are
            // really worried about this, we can replace the versionNonce with the socket id.
            elements.push(element);
          }
          delete localElementMap[element.id];
        } else {
          elements.push(element);
          delete localElementMap[element.id];
        }

        return elements;
      }, [] as Mutable<typeof elements>)
      // add local elements that weren't deleted or on remote
      .concat(...Object.values(localElementMap));

    // Avoid broadcasting to the rest of the collaborators the scene
    // we just received!
    // Note: this needs to be set before updating the scene as it
    // synchronously calls render.
    this.setLastBroadcastedOrReceivedSceneVersion(getSceneVersion(newElements));

    return newElements as ReconciledElements;
  };

  private loadImageFiles = throttle(async () => {
    const { loadedFiles } = await this.fetchImageFilesFromFirebase({
      elements: this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      appState: this.excalidrawAPI.getAppState(),
    });

    this.excalidrawAPI.setFiles(loadedFiles);
  }, LOAD_IMAGES_TIMEOUT);

  private handleRemoteSceneUpdate = (
    elements: ReconciledElements,
    { init = false }: { init?: boolean } = {},
  ) => {
    this.excalidrawAPI.updateScene({
      elements,
      commitToHistory: !!init,
    });

    // We haven't yet implemented multiplayer undo functionality, so we clear the undo stack
    // when we receive any messages from another peer. This UX can be pretty rough -- if you
    // undo, a user makes a change, and then try to redo, your element(s) will be lost. However,
    // right now we think this is the right tradeoff.
    this.excalidrawAPI.history.clear();

    this.loadImageFiles();
  };

  private onPointerMove = () => {
    if (this.idleTimeoutId) {
      window.clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }
    this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);
    if (!this.activeIntervalId) {
      this.activeIntervalId = window.setInterval(
        this.reportActive,
        ACTIVE_THRESHOLD,
      );
    }
  };

  private onVisibilityChange = () => {
    if (document.hidden) {
      if (this.idleTimeoutId) {
        window.clearTimeout(this.idleTimeoutId);
        this.idleTimeoutId = null;
      }
      if (this.activeIntervalId) {
        window.clearInterval(this.activeIntervalId);
        this.activeIntervalId = null;
      }
      this.onIdleStateChange(UserIdleState.AWAY);
    } else {
      this.idleTimeoutId = window.setTimeout(this.reportIdle, IDLE_THRESHOLD);
      this.activeIntervalId = window.setInterval(
        this.reportActive,
        ACTIVE_THRESHOLD,
      );
      this.onIdleStateChange(UserIdleState.ACTIVE);
    }
  };

  private reportIdle = () => {
    this.onIdleStateChange(UserIdleState.IDLE);
    if (this.activeIntervalId) {
      window.clearInterval(this.activeIntervalId);
      this.activeIntervalId = null;
    }
  };

  private reportActive = () => {
    this.onIdleStateChange(UserIdleState.ACTIVE);
  };

  private initializeIdleDetector = () => {
    document.addEventListener(EVENT.POINTER_MOVE, this.onPointerMove);
    document.addEventListener(EVENT.VISIBILITY_CHANGE, this.onVisibilityChange);
  };

  setCollaborators(sockets: string[]) {
    this.setState((state) => {
      const collaborators: InstanceType<
        typeof CollabWrapper
      >["collaborators"] = new Map();
      for (const socketId of sockets) {
        if (this.collaborators.has(socketId)) {
          collaborators.set(socketId, this.collaborators.get(socketId)!);
        } else {
          collaborators.set(socketId, {});
        }
      }
      this.collaborators = collaborators;
      this.excalidrawAPI.updateScene({ collaborators });
    });
  }

  public setLastBroadcastedOrReceivedSceneVersion = (version: number) => {
    this.lastBroadcastedOrReceivedSceneVersion = version;
  };

  public getLastBroadcastedOrReceivedSceneVersion = () => {
    return this.lastBroadcastedOrReceivedSceneVersion;
  };

  public getSceneElementsIncludingDeleted = () => {
    return this.excalidrawAPI.getSceneElementsIncludingDeleted();
  };

  onPointerUpdate = (payload: {
    pointer: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["pointer"];
    button: SocketUpdateDataSource["MOUSE_LOCATION"]["payload"]["button"];
    pointersMap: Gesture["pointers"];
  }) => {
    payload.pointersMap.size < 2 &&
      this.portal.socket &&
      this.portal.broadcastMouseLocation(payload);
  };

  onIdleStateChange = (userState: UserIdleState) => {
    this.setState({ userState });
    this.portal.broadcastIdleChange(userState);
  };

  broadcastElements = (elements: readonly ExcalidrawElement[]) => {
    if (
      getSceneVersion(elements) >
      this.getLastBroadcastedOrReceivedSceneVersion()
    ) {
      this.portal.broadcastScene(
        SCENE.UPDATE,
        this.getSyncableElements(elements),
        false,
      );
      this.lastBroadcastedOrReceivedSceneVersion = getSceneVersion(elements);
      this.queueBroadcastAllElements();
    }
  };

  queueBroadcastAllElements = throttle(() => {
    this.portal.broadcastScene(
      SCENE.UPDATE,
      this.getSyncableElements(
        this.excalidrawAPI.getSceneElementsIncludingDeleted(),
      ),
      true,
    );
    const currentVersion = this.getLastBroadcastedOrReceivedSceneVersion();
    const newVersion = Math.max(
      currentVersion,
      getSceneVersion(this.getSceneElementsIncludingDeleted()),
    );
    this.setLastBroadcastedOrReceivedSceneVersion(newVersion);
  }, SYNC_FULL_SCENE_INTERVAL_MS);

  handleClose = () => {
    this.setState({ modalIsShown: false });
  };

  onUsernameChange = (username: string) => {
    this.setState({ username });
    saveUsernameToLocalStorage(username);
  };

  onCollabButtonClick = () => {
    this.setState({
      modalIsShown: true,
    });
  };

  getSyncableElements = (elements: readonly ExcalidrawElement[]) =>
    elements.filter((el) => el.isDeleted || !isInvisiblySmallElement(el));

  /** PRIVATE. Use `this.getContextValue()` instead. */
  private contextValue: CollabAPI | null = null;

  /** Getter of context value. Returned object is stable. */
  getContextValue = (): CollabAPI => {
    if (!this.contextValue) {
      this.contextValue = {} as CollabAPI;
    }

    this.contextValue.isCollaborating = () => this.isCollaborating;
    this.contextValue.username = this.state.username;
    this.contextValue.onPointerUpdate = this.onPointerUpdate;
    this.contextValue.initializeSocketClient = this.initializeSocketClient;
    this.contextValue.onCollabButtonClick = this.onCollabButtonClick;
    this.contextValue.broadcastElements = this.broadcastElements;
    this.contextValue.fetchImageFilesFromFirebase = this.fetchImageFilesFromFirebase;
    return this.contextValue;
  };

  render() {
    const { modalIsShown, username, errorMessage, activeRoomLink } = this.state;

    return (
      <>
        {modalIsShown && (
          <RoomDialog
            handleClose={this.handleClose}
            activeRoomLink={activeRoomLink}
            username={username}
            onUsernameChange={this.onUsernameChange}
            onRoomCreate={this.openPortal}
            onRoomDestroy={this.closePortal}
            setErrorMessage={(errorMessage) => {
              this.setState({ errorMessage });
            }}
            theme={this.excalidrawAPI.getAppState().theme}
          />
        )}
        {errorMessage && (
          <ErrorDialog
            message={errorMessage}
            onClose={() => this.setState({ errorMessage: "" })}
          />
        )}
        <CollabContextProvider
          value={{
            api: this.getContextValue(),
          }}
        />
      </>
    );
  }
}

declare global {
  interface Window {
    collab: InstanceType<typeof CollabWrapper>;
  }
}

if (
  process.env.NODE_ENV === ENV.TEST ||
  process.env.NODE_ENV === ENV.DEVELOPMENT
) {
  window.collab = window.collab || ({} as Window["collab"]);
}

export default CollabWrapper;
