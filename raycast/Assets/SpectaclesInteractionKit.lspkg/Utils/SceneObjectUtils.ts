export const DEFAULT_MAX_PARENT_SEARCH_LEVELS: number = 16
export const DEFAULT_MAX_CHILD_SEARCH_LEVELS: number = 16

function searchComponentInChildren(
  currentObject: SceneObject,
  currentDepth: number,
  maxDepth: number,
  componentType: keyof ComponentNameMap | TypeName<BaseScriptComponent>
): Component | null {
  if (currentDepth >= maxDepth) {
    return null
  }
  const childrenCount = currentObject.getChildrenCount()
  for (let i = 0; i < childrenCount; i++) {
    const child = currentObject.getChild(i)
    const component = child.getComponent(componentType as any)
    if (component) {
      return component
    }
    const foundInChildren = searchComponentInChildren(child, currentDepth + 1, maxDepth, componentType)
    if (foundInChildren) {
      return foundInChildren
    }
  }
  return null
}

function searchAllComponentsInChildren(
  currentObject: SceneObject,
  currentDepth: number,
  maxDepth: number,
  componentType: keyof ComponentNameMap | TypeName<BaseScriptComponent>,
  results: Component[]
): void {
  if (currentDepth >= maxDepth) {
    return
  }
  const childrenCount = currentObject.getChildrenCount()
  for (let i = 0; i < childrenCount; i++) {
    const child = currentObject.getChild(i)
    const matchingComponents = child.getComponents(componentType as any)
    for (let j = 0; j < matchingComponents.length; j++) {
      results.push(matchingComponents[j])
    }
    searchAllComponentsInChildren(child, currentDepth + 1, maxDepth, componentType, results)
  }
}

/**
 * Searches for a SceneObject with the given name in the tree rooted at the given root SceneObject.
 *
 * @param root - The root SceneObject of the tree to search.
 * @param name - The name of the SceneObject to search for.
 * @returns The first SceneObject with the given name if it exists in the tree, or undefined otherwise.
 */
export function findSceneObjectByName(root: SceneObject | null, name: string): SceneObject | null {
  if (root === null) {
    const rootObjectCount = global.scene.getRootObjectsCount()
    let current = 0
    while (current < rootObjectCount) {
      const result = findSceneObjectByName(global.scene.getRootObject(current), name)
      if (result) {
        return result
      }
      current += 1
    }
  } else {
    if (root.name === name) {
      return root
    }

    for (let i = 0; i < root.getChildrenCount(); i++) {
      const child = root.getChild(i)
      const result = findSceneObjectByName(child, name)
      if (result) {
        return result
      }
    }
  }
  return null
}

/**
 * Checks if a {@link SceneObject} is a descendant of another.
 * @param sceneObject - the potential descendant.
 * @param root - the potential ascendant.
 * @returns true, if sceneObject is a descendant of root,
 * otherwise, returns false.
 */
export function isDescendantOf(sceneObject: SceneObject, root: SceneObject): boolean {
  if (sceneObject === root) {
    return true
  }

  const parent = sceneObject.getParent()
  if (parent === null) {
    return false
  }

  return isDescendantOf(parent, root)
}

/**
 * [ByKey] Finds the first Component of a given type in the children of a SceneObject, searching recursively.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The string key of the component type to find (e.g., "Component.RenderMeshVisual").
 * @param maxDepth - The maximum number of levels to search down the hierarchy.
 * @returns The first matching Component found, or null if none is found.
 */
export function findComponentInChildren<K extends keyof ComponentNameMap>(
  sceneObject: SceneObject,
  componentType: K,
  maxDepth?: number
): ComponentNameMap[K] | null

/**
 * [ByScriptType] Finds the first Component of a given script type in the children of a SceneObject, searching
 * recursively.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The script type name (e.g., Interactable.getTypeName())) to find.
 * @param maxDepth - The maximum number of levels to search down the hierarchy.
 * @returns The first matching Component found, or null if none is found.
 */
export function findComponentInChildren<T extends BaseScriptComponent>(
  sceneObject: SceneObject,
  componentType: TypeName<T>,
  maxDepth?: number
): T | null

export function findComponentInChildren(
  sceneObject: SceneObject,
  componentType: keyof ComponentNameMap | TypeName<BaseScriptComponent>,
  maxDepth: number = DEFAULT_MAX_CHILD_SEARCH_LEVELS
): Component | null {
  return searchComponentInChildren(sceneObject, 0, maxDepth, componentType)
}

/**
 * [ByKey] Finds all Components of a given type in the children of a SceneObject, searching recursively.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The string key of the component type to find (e.g., "Component.RenderMeshVisual").
 * @param maxDepth - The maximum number of levels to search down the hierarchy.
 * @returns An array of all matching Components found.
 */
export function findAllComponentsInChildren<K extends keyof ComponentNameMap>(
  sceneObject: SceneObject,
  componentType: K,
  maxDepth?: number
): ComponentNameMap[K][]

/**
 * [ByScriptType] Finds all Components of a given script type in the children of a SceneObject, searching recursively.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The script type name (e.g., Interactable.getTypeName())) to find.
 * @param maxDepth - The maximum number of levels to search down the hierarchy.
 * @returns An array of all matching Components found.
 */
export function findAllComponentsInChildren<T extends BaseScriptComponent>(
  sceneObject: SceneObject,
  componentType: TypeName<T>,
  maxDepth?: number
): T[]

export function findAllComponentsInChildren(
  sceneObject: SceneObject,
  componentType: keyof ComponentNameMap | TypeName<BaseScriptComponent>,
  maxDepth: number = DEFAULT_MAX_CHILD_SEARCH_LEVELS
): Component[] {
  const results: Component[] = []
  searchAllComponentsInChildren(sceneObject, 0, maxDepth, componentType, results)
  return results
}

/**
 * [ByKey] Finds the first Component of a given type on the SceneObject itself or in its children.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The string key of the component type to find (e.g., "Component.RenderMeshVisual").
 * @param maxDepth - The maximum number of levels to search down the hierarchy (for children).
 * @returns The first matching Component found, or null if none is found.
 */
export function findComponentInSelfOrChildren<K extends keyof ComponentNameMap>(
  sceneObject: SceneObject,
  componentType: K,
  maxDepth?: number
): ComponentNameMap[K] | null

/**
 * [ByScriptType] Finds the first Component of a given script type on the SceneObject itself or in its children.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The script type name (e.g., Interactable.getTypeName())) to find.
 * @param maxDepth - The maximum number of levels to search down the hierarchy (for children).
 * @returns The first matching Component found, or null if none is found.
 */
export function findComponentInSelfOrChildren<T extends BaseScriptComponent>(
  sceneObject: SceneObject,
  componentType: TypeName<T>,
  maxDepth?: number
): T | null

export function findComponentInSelfOrChildren(
  sceneObject: SceneObject,
  componentType: keyof ComponentNameMap | TypeName<BaseScriptComponent>,
  maxDepth: number = DEFAULT_MAX_CHILD_SEARCH_LEVELS
): Component | null {
  const selfComponent = sceneObject.getComponent(componentType as any)
  if (selfComponent) {
    return selfComponent
  }
  return findComponentInChildren(sceneObject, componentType as any, maxDepth)
}

/**
 * [ByKey] Finds all Components of a given type on the SceneObject itself and in its children.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The string key of the component type to find (e.g., "Component.RenderMeshVisual").
 * @param maxDepth - The maximum number of levels to search down the hierarchy (for children).
 * @returns An array of all matching Components found.
 */
export function findAllComponentsInSelfOrChildren<K extends keyof ComponentNameMap>(
  sceneObject: SceneObject,
  componentType: K,
  maxDepth?: number
): ComponentNameMap[K][]

/**
 * [ByScriptType] Finds all Components of a given script type on the SceneObject itself and in its children.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The script type name (e.g., Interactable.getTypeName())) to find.
 * @param maxDepth - The maximum number of levels to search down the hierarchy (for children).
 * @returns An array of all matching Components found.
 */
export function findAllComponentsInSelfOrChildren<T extends BaseScriptComponent>(
  sceneObject: SceneObject,
  componentType: TypeName<T>,
  maxDepth?: number
): T[]

export function findAllComponentsInSelfOrChildren(
  sceneObject: SceneObject,
  componentType: keyof ComponentNameMap | TypeName<BaseScriptComponent>,
  maxDepth: number = DEFAULT_MAX_CHILD_SEARCH_LEVELS
): Component[] {
  const results = sceneObject.getComponents(componentType as any)
  searchAllComponentsInChildren(sceneObject, 0, maxDepth, componentType, results)
  return results
}

/**
 * [ByKey] Finds the first Component of a given type in the parents of a SceneObject, searching recursively upwards.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The string key of the component type to find (e.g., "Component.RenderMeshVisual").
 * @param maxLevels - The maximum number of levels to search up the hierarchy.
 * @returns The first matching Component found, or null if none is found.
 */
export function findComponentInParents<K extends keyof ComponentNameMap>(
  sceneObject: SceneObject,
  componentType: K,
  maxLevels?: number
): ComponentNameMap[K] | null

/**
 * [ByScriptType] Finds the first Component of a given script type in the parents of a SceneObject, searching
 * recursively upwards.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The script type name (e.g., Interactable.getTypeName())) to find.
 * @param maxLevels - The maximum number of levels to search up the hierarchy.
 * @returns The first matching Component found, or null if none is found.
 */
export function findComponentInParents<T extends BaseScriptComponent>(
  sceneObject: SceneObject,
  componentType: TypeName<T>,
  maxLevels?: number
): T | null

export function findComponentInParents(
  sceneObject: SceneObject,
  componentType: keyof ComponentNameMap | TypeName<BaseScriptComponent>,
  maxLevels: number = DEFAULT_MAX_PARENT_SEARCH_LEVELS
): Component | null {
  let parent = sceneObject.getParent()
  let levelsSearched = 0
  while (parent && levelsSearched < maxLevels) {
    const component = parent.getComponent(componentType as any)
    if (component) {
      return component
    }
    parent = parent.getParent()
    levelsSearched++
  }
  return null
}

/**
 * [ByKey] Finds all Components of a given type in the parents of a SceneObject, searching recursively upwards.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The string key of the component type to find (e.g., "Component.RenderMeshVisual").
 * @param maxLevels - The maximum number of levels to search up the hierarchy.
 * @returns An array of all matching Components found.
 */
export function findAllComponentsInParents<K extends keyof ComponentNameMap>(
  sceneObject: SceneObject,
  componentType: K,
  maxLevels?: number
): ComponentNameMap[K][]

/**
 * [ByScriptType] Finds all Components of a given script type in the parents of a SceneObject, searching recursively
 * upwards.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The script type name (e.g., Interactable.getTypeName())) to find.
 * @param maxLevels - The maximum number of levels to search up the hierarchy.
 * @returns An array of all matching Components found.
 */
export function findAllComponentsInParents<T extends BaseScriptComponent>(
  sceneObject: SceneObject,
  componentType: TypeName<T>,
  maxLevels?: number
): T[]

export function findAllComponentsInParents(
  sceneObject: SceneObject,
  componentType: keyof ComponentNameMap | TypeName<BaseScriptComponent>,
  maxLevels: number = DEFAULT_MAX_PARENT_SEARCH_LEVELS
): Component[] {
  const results: Component[] = []
  let parent = sceneObject.getParent()
  let levelsSearched = 0

  while (parent && levelsSearched < maxLevels) {
    const matchingComponents = parent.getComponents(componentType as any)
    for (let j = 0; j < matchingComponents.length; j++) {
      results.push(matchingComponents[j])
    }

    parent = parent.getParent()
    levelsSearched++
  }
  return results
}

/**
 * [ByKey] Finds the first Component of a given type on the SceneObject itself or in its parents.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The string key of the component type to find (e.g., "Component.RenderMeshVisual").
 * @param maxLevels - The maximum number of levels to search up the hierarchy (for parents).
 * @returns The first matching Component found, or null if none is found.
 */
export function findComponentInSelfOrParents<K extends keyof ComponentNameMap>(
  sceneObject: SceneObject,
  componentType: K,
  maxLevels?: number
): ComponentNameMap[K] | null

/**
 * [ByScriptType] Finds the first Component of a given script type on the SceneObject itself or in its parents.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The script type name (e.g., Interactable.getTypeName())) to find.
 * @param maxLevels - The maximum number of levels to search up the hierarchy (for parents).
 * @returns The first matching Component found, or null if none is found.
 */
export function findComponentInSelfOrParents<T extends BaseScriptComponent>(
  sceneObject: SceneObject,
  componentType: TypeName<T>,
  maxLevels?: number
): T | null

export function findComponentInSelfOrParents(
  sceneObject: SceneObject,
  componentType: keyof ComponentNameMap | TypeName<BaseScriptComponent>,
  maxLevels: number = DEFAULT_MAX_PARENT_SEARCH_LEVELS
): Component | null {
  const selfComponent = sceneObject.getComponent(componentType as any)
  if (selfComponent) {
    return selfComponent
  }
  return findComponentInParents(sceneObject, componentType as any, maxLevels)
}

/**
 * [ByKey] Finds all Components of a given type on the SceneObject itself and in its parents.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The string key of the component type to find (e.g., "Component.RenderMeshVisual").
 * @param maxLevels - The maximum number of levels to search up the hierarchy (for parents).
 * @returns An array of all matching Components found.
 */
export function findAllComponentsInSelfOrParents<K extends keyof ComponentNameMap>(
  sceneObject: SceneObject,
  componentType: K,
  maxLevels?: number
): ComponentNameMap[K][]

/**
 * [ByScriptType] Finds all Components of a given script type on the SceneObject itself and in its parents.
 * @param sceneObject - The SceneObject to start the search from.
 * @param componentType - The script type name (e.g., Interactable.getTypeName())) to find.
 * @param maxLevels - The maximum number of levels to search up the hierarchy (for parents).
 * @returns An array of all matching Components found.
 */
export function findAllComponentsInSelfOrParents<T extends BaseScriptComponent>(
  sceneObject: SceneObject,
  componentType: TypeName<T>,
  maxLevels?: number
): T[]

export function findAllComponentsInSelfOrParents(
  sceneObject: SceneObject,
  componentType: keyof ComponentNameMap | TypeName<BaseScriptComponent>,
  maxLevels: number = DEFAULT_MAX_PARENT_SEARCH_LEVELS
): Component[] {
  const results = sceneObject.getComponents(componentType as any)

  let parent = sceneObject.getParent()
  let levelsSearched = 0

  while (parent && levelsSearched < maxLevels) {
    const matchingComponents = parent.getComponents(componentType as any)
    for (let j = 0; j < matchingComponents.length; j++) {
      results.push(matchingComponents[j])
    }
    parent = parent.getParent()
    levelsSearched++
  }

  return results
}
