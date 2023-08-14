import type { JSX } from "solid-js";
import { Component, createContext, createSignal, useContext } from "solid-js";
import { createStore } from "solid-js/store";
import { invoke } from "@tauri-apps/api";

import {
  APIRepositoryResponse,
  ICommitFrame,
  IFileListItem,
  IFileTree,
  isIAPICommitFrame,
} from "../types";

/**
 * Main data structure for the UI application.
 *
 * We track the current repository (path in local filesystem), current branch, current commit,
 * play status, path inside the git file tree, list of commits (loaded with pagination),
 * list of files (loaded per commit visit)
 *
 * The data structure is read using `store` variable and then the needed key,
 * like `store.currentBranch`
 *
 * There are setters or modifiers to update the data structure (defined in `makeRepository`)
 */
interface IStore {
  isReady: boolean; // Repository is open, first batch of commits, count of commits and first commit details are fetched
  repositoryPath?: string;

  currentBranch?: string;
  currentCommitIndex: number;
  currentObjectId?: string;
  currentFileTree?: IFileTree;

  playSpeed: number;
  isPlaying: boolean;

  commits: Array<ICommitFrame>;
  commitsCount: number;
  loadedCommitsCount: number;
  isFetchingCommits: boolean;
  lastErrorMessage?: string;

  // UI layout state
  isCommitSidebarVisible: boolean;
  isFileTreeVisible: boolean;

  fileTreeViewers: [IFileListItem];
}

interface IRepositoryProviderPropTypes {
  children: JSX.Element;
}

interface ICommitDetails extends ICommitFrame {
  fileTree?: IFileTree;
}

/**
 * Function to fetch the details for a single commit, generally the file list.
 * The file list is flat, unlike a tree in Rust code. Each item has its relative path.
 *
 * @param commitId string commit hash
 * @returns Promise of commit's detail with the file list
 */
const getCommit = (commitId: string): Promise<ICommitDetails> =>
  new Promise((resolve, reject) => {
    invoke("get_commit_details", {
      commitId,
    })
      .then((response) => {
        if (isIAPICommitFrame(response)) {
          const fileTree = !!response.file_structure
            ? {
                objectId: response.file_structure.object_id,
                blobs: response.file_structure.blobs.map((x) => ({
                  id: x.object_id,
                  objectId: x.object_id,
                  relativeRootPath: x.relative_root_path,
                  name: x.name,
                  isDirectory: x.is_directory,
                  size: x.size,
                })),
              }
            : undefined;

          resolve({
            commitId: response.commit_id,
            commitMessage: response.commit_message,
            fileTree,
          });
        }
      })
      .catch((error) => {
        reject(error);
      });
  });

const getDefaultStore = () => {
  const [initialPath, setInitialPath] = createSignal<Array<string>>([]);

  const constDefaultStore: IStore = {
    isReady: false,
    currentCommitIndex: 0,
    playSpeed: 4,
    isPlaying: false,
    commits: [],
    commitsCount: 0, // Total count of commits in this repository, sent when repository is first opened
    loadedCommitsCount: 0, // How many commits have be fetched in frontend
    isFetchingCommits: false,

    isCommitSidebarVisible: false,
    isFileTreeVisible: false,

    fileTreeViewers: [
      {
        currentPath: initialPath,
        setCurrentPath: setInitialPath,
      },
    ],
  };
  return constDefaultStore;
};

/**
 * Function to create the actual SolidJS store with the IStore data structure and
 * the setters to modifiers to the data.
 *
 * @param defaultStore IStore default values
 * @returns readly IStore data and the setters/modifiers
 */
const makeRepository = (defaultStore: IStore = getDefaultStore()) => {
  const [store, setStore] = createStore<IStore>(defaultStore);

  return [
    store,
    {
      setRepositoryPath(path: string) {
        setStore("repositoryPath", path);
      },

      openRepository() {
        if (!store.repositoryPath) {
          return;
        }
        setStore(() => ({
          ...getDefaultStore(),
          isPathInvalid: false,
          isFetchingCommits: true,
        }));

        invoke("open_repository", { path: store.repositoryPath })
          .then(() => invoke("prepare_cache"))
          .then((response) => {
            setStore("commitsCount", response as number);
            return invoke("get_commits");
          })
          .then((response) => {
            const data = response as APIRepositoryResponse;
            setStore((state) => ({
              ...state,
              commits: data.map((x) => ({
                commitId: x[0],
                commitMessage: x[1],
              })),
              currentPathInFileTree: [],
              loadedCommitsCount: data.length,
              isFetchingCommits: false,
              currentCommitIndex: 0,
            }));

            return getCommit(data[0][0]);
          })
          .then((response) => {
            setStore((state) => ({
              ...state,
              currentFileTree: response.fileTree,
              isReady: true,
              isFetchingCommits: false,
            }));
          })
          .catch((error) => {
            setStore("lastErrorMessage", error as string);
          });
      },

      loadNextCommits() {
        if (!store.isReady || store.isFetchingCommits) {
          return;
        }
        setStore("isFetchingCommits", true);

        invoke("get_commits", {
          afterCommitId: store.commits.at(-1)?.commitId,
        }).then((response) => {
          const data = response as APIRepositoryResponse;
          setStore("commits", [
            ...store.commits,
            ...data.map((x) => ({
              commitId: x[0],
              commitMessage: x[1],
            })),
          ]);
          setStore(
            "loadedCommitsCount",
            store.loadedCommitsCount + data.length
          );
          setStore("isFetchingCommits", false);
        });
      },

      setCurrentCommitIndex(commitIndex: number) {
        if (!store.isReady) {
          return;
        }

        setStore((state) => ({
          ...state,
          currentCommitIndex: commitIndex,
          currentFileTree: undefined,
          isPlaying: false,
        }));

        getCommit(store.commits[commitIndex].commitId).then((response) => {
          setStore("currentFileTree", response.fileTree);
        });
      },

      setPlaySpeed() {
        setStore("playSpeed", (playSpeed) =>
          playSpeed < 32 ? playSpeed * 2 : 1
        );
      },

      nextCommit() {
        if (!store.isReady) {
          return;
        }

        if (store.currentCommitIndex >= store.commitsCount - 1) {
          setStore("isPlaying", false);
        } else {
          setStore((state) => ({
            ...state,
            currentCommitIndex: state.currentCommitIndex + 1,
            isPlaying: true,
          }));

          getCommit(store.commits[store.currentCommitIndex].commitId).then(
            (response) => {
              setStore("currentFileTree", response.fileTree);
            }
          );
        }
      },

      pause() {
        setStore("isPlaying", false);
      },

      setPathInFileTree(index: number, path: Array<string>) {
        store.fileTreeViewers[index].setCurrentPath(path);
      },

      appendPathInFileTree(index: number, path: string) {
        store.fileTreeViewers[index].setCurrentPath([
          ...store.fileTreeViewers[index].currentPath(),
          path,
        ]);
      },

      changePathDirectoryUp(index: number) {
        store.fileTreeViewers[index].setCurrentPath(
          store.fileTreeViewers[index]
            .currentPath()
            .slice(0, store.fileTreeViewers[index].currentPath().length - 1)
        );
      },

      getCurrentPathForIndex(index: number) {
        return store.fileTreeViewers[index].currentPath;
      },
    },
  ] as const; // `as const` forces tuple type inference
};

const repository = makeRepository();

export const RepositoryProvider: Component<IRepositoryProviderPropTypes> = (
  props: IRepositoryProviderPropTypes
) => (
  <RepositoryContext.Provider value={repository}>
    {props.children}
  </RepositoryContext.Provider>
);

type TRepositoryContext = ReturnType<typeof makeRepository>;

export const RepositoryContext = createContext<TRepositoryContext>(repository);
export const useRepository = () => useContext(RepositoryContext);
