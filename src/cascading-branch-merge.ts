import { RepositoryReference } from './github-models'
import { HandlerContext } from './models'

/**
 * @description This class contains the main "Cascading Auto-Merge" code.
 *  Note: All the utility functions are kept within this class,
 *        rather than putting it into the 'utility.ts' file.
 *        That way all required components can be found in one place.
 *        If we decide to contribute this code back 'upstream',
 *        we can make a decision than on how to structure/refactor the code.
 *
 * TODO: This contains some 'boilerplate' code that can be optimized
 *       possible functions: 'create-PR', 'create-Issue', 'create-Comment', 'merge-PR'
 */

/**
 * @description support structure for 'getRepoBranchMergeOrder'
 */
interface branch {
  name: string;
  commit: object;
  protected: boolean;
  protection: object;
}

/**
 * @function cascadingBranchMerge
 * @description Merge all 'Release' branches by ascending order of their semantic version
 *              Multiple GitHub API calls are being processed as a single transaction!
 *              (despite the definition 'transaction', rollback is not automatic)
 *
 * @param prefixes
 * @param refBranch
 * @param headBranch
 * @param repository
 * @param context
 */
export async function cascadingBranchMerge(prefixes: string[], refBranch: string, headBranch: string, baseBranch: string, repository: RepositoryReference, context: HandlerContext, pullNumber: number): Promise<any> {
  const tempRequestObject = { owner: repository.owner, repo: repository.repo, per_page: 1000 } // not sure if '1000' works, or maybe it stops at '100' by default
  const branches = (await context.github.repos.listBranches(tempRequestObject)).data
  let mergeListHead: string[] = []
  let mergeListBase: string[] = []
  let mergeLists: string[][] = []
  let mergeList: string[] = []
  // create a list of branches that should be used for 'cascading-auto-merge' 
  // NOTE: if the current 'headBranch'- prefix is not in the configured prefix list
  //       we get an empty list which basically results in '0' execution of the 
  //       'cascading-merge' loop
  // -------------------------------------------------------------------------
  // prefixes   = its the list of all 'prefixes' we have configured to use in cascading auto merge (auto-merge.yml)
  // prefix     = the name of prefix name of the branch we care about
  // headBranch = the "source" branch, the one we made changes to
  // branches   = all branches of the Repository
  prefixes.forEach(function (prefix) {
    if (headBranch.startsWith(prefix)) {
      mergeListHead = getBranchMergeOrder(prefix, headBranch, branches)
    }

    if (baseBranch.startsWith(prefix)) {
      mergeListBase = getBranchMergeOrder(prefix, baseBranch, branches)
    }
  })

  mergeLists[0] = mergeListHead
  mergeLists[1] = mergeListBase

  // Execute cascading merge (the key purpose of this function)
  // Do it ones for each List (Head/Base)
  for (let a = 0; a < 2; a++) {
    mergeList = mergeLists[a]

    // This has to happen sequentially, otherwise there is no commit to build the next PR on
    // Note: This loop handles multiple GitHub API calls as a single unit of work.
    for (let i = 0; i < mergeList.length - 1; i++) {
      let res: any

      // -----------------------------------------------------------------------------------------------------------------
      // CREATE a PR for the next subsequent merge
      // -----------------------------------------------------------------------------------------------------------------
      try {
        res = await context.github.pulls.create({
          owner: repository.owner,
          repo: repository.repo,
          base: mergeList[i + 1],
          head: mergeList[i],
          title: 'Cascading Auto-Merge: merge [' + mergeList[i] + '] into [' + mergeList[i + 1] + ']',
          body: 'This PR was created automatically by the probot auto-merge app.'
        })
      }
      catch (error)   // could not create the PR
      {
        console.error(error)

        if (error.status === 422 && error.errors[0].message.startsWith('No commits between')) {
          // create a comment in the HEAD Branch PR
          await context.github.issues.createComment({
            owner: repository.owner,
            repo: repository.repo,
            issue_number: pullNumber,
            body: "I Tried to create a cascading PR but encountered an issue, [" + error.errors[0].message + "] but I am going to continue the cascading merge"
          })
          // goto the next PR iteration
          continue
        }
        else if (error.status === 422 && error.errors[0].message.startsWith('A pull request already exists')) {
          // put a comment in the original PR, noting that the cascading failed
          await context.github.issues.createComment({
            owner: repository.owner,
            repo: repository.repo,
            issue_number: pullNumber,
            body: "I Tried to create a cascading PR but encountered an issue, [" + error.errors[0].message + "]"
          })
          break
        }
        else {
          // put a comment in the original PR, noting that the cascading failed
          await context.github.issues.createComment({
            owner: repository.owner,
            repo: repository.repo,
            issue_number: pullNumber,
            body: "Tried to create a cascading PR but encountered an issue [" + error.errors[0].message + "]"
          })
          // create an Issue in the Repo. that the cascading failed
          await context.github.issues.create({
            owner: repository.owner,
            repo: repository.repo,
            title: "Problem with cascading Auto-Merge [ " + error.errors[0].message + "]",
            body: "Issue with cascading auto-merge, please try to resolve the Issue, if necessary. **Cascading Auto-Merge has been stopped!** [" + error.errors[0].message + " ]"
          })
          // stop the cascading auto-merge
          break
        }
      }

      // create a comment in the HEAD Branch PR
      await context.github.issues.createComment({
        owner: repository.owner,
        repo: repository.repo,
        issue_number: pullNumber,
        body: "Created cascading Auto-Merge pull request #" + res.data.number
      })

      // -----------------------------------------------------------------------------------------------------------------
      // MERGE the PR
      // -----------------------------------------------------------------------------------------------------------------
      try {
        await context.github.pulls.merge({
          owner: repository.owner,
          repo: repository.repo,
          pull_number: res.data.number
        })
      }
      catch (error) {
        console.error(error)

        if (error.status === 405) {
          // put a comment in the original PR, noting that the cascading failed
          await context.github.issues.createComment({
            owner: repository.owner,
            repo: repository.repo,
            issue_number: pullNumber,
            body: "Could not auto merge PR #" + res.data.number + ". Possible merge conflict"
          })
          // create an Issue to notify Repo users
          await context.github.issues.create({
            owner: repository.owner,
            repo: repository.repo,
            title: "Problem with cascading Auto-Merge [ mergable:" + error.mergable + " ]",
            body: "Issue with cascading auto-merge, please try to resolve the Issue, if necessary. **Cascading Auto-Merge has been stopped!** - PR #" + res.data.number
          })
          // stop the cascading auto-merge
          break
        }
        else {
          await context.github.issues.create({
            owner: repository.owner,
            repo: repository.repo,
            title: "Problem with cascading Auto-Merge [ " + error.errors[0].message + " ]",
            body: "Issue with a PR created by cascading auto-merge, please try to resolve the Issue. **Cascading Auto-Merge has been stopped!**"
          })
          break
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Create the last commit, into a specified 'refBranch' (default), if provided
  // ---------------------------------------------------------------------------
  let ref: any
  if (refBranch.length > 0) {
    try {
      ref = await context.github.pulls.create({
        owner: repository.owner,
        repo: repository.repo,
        base: refBranch,
        head: headBranch,
        title: 'Cascading Auto-Merge: merge [' + headBranch + '] into [' + refBranch + ']',
        body: 'This PR was created automatically by the probot auto-merge app.'
      })

      // create a comment in the HEAD Branch PR
      await context.github.issues.createComment({
        owner: repository.owner,
        repo: repository.repo,
        issue_number: pullNumber,
        body: "Created cascading Auto-Merge FINAL pull request #" + ref.data.number
      })

      // MERGE the PR
      await context.github.pulls.merge({
        owner: repository.owner,
        repo: repository.repo,
        pull_number: ref.data.number
      })
    }
    catch (error)   // could not create the PR
    {
      console.error(error)
      if (error.status === 405) {
        // put a comment in the original PR, noting that merging failed
        await context.github.issues.createComment({
          owner: repository.owner,
          repo: repository.repo,
          issue_number: pullNumber,
          body: "Could not auto merge PR #" + ref.data.number + ". Possible merge conflict"
        })
        // create an Issue to notify Repo users
        await context.github.issues.create({
          owner: repository.owner,
          repo: repository.repo,
          title: "Problem with cascading Auto-Merge [ mergable:" + error.mergable + " ]",
          body: "Issue with cascading auto-merge, please try to resolve the Issue, if necessary. **Cascading Auto-Merge has been stopped!** - PR #" + ref.data.number
        })
      }
      else {
        // create a comment in the HEAD Branch PR
        await context.github.issues.createComment({
          owner: repository.owner,
          repo: repository.repo,
          issue_number: pullNumber,
          body: "I Tried to create a cascading PR but encountered an issue, [" + error.errors[0].message + "]"
        })
      }
    }
  }
}

/**
 * @function getRepoBranchMergeOrder
 * @description
 *  Filter repository branches based on a 'prefix/' and return an ordered list.
 *  This function requires that the branches use semantic versioning
 *  Example:
 *    release/1.0.1-rc.1
 *
 * @param prefix
 * @param headBranch
 * @param branches
 */
function getBranchMergeOrder(prefix: string, headBranch: string, branches: branch[]): string[] {
  let branchList: string[] = []
  // create a list from the 'branches' array, containing only branch names
  branches.forEach(function (branch) {
    branchList.push(branch.name)
  })

  // filter the branch names that start with the required prefix
  branchList = branchList.filter(b => b.startsWith(prefix))

  const len = branchList.length

  // Bubble Sort - I know... but it's fine for our purpose
  for (let j = 0; j < len - 1; j++) {
    for (let i = 0; i < len - 1; i++) {
      const res = isBiggerThan(semanticVersionToArray(branchList[i]), semanticVersionToArray(branchList[i + 1]))

      if (res) {
        swap(branchList, i, i + 1)
      }
    }
  }

  // return only the versions that are 'younger' than the PR version
  while (branchList[0] !== headBranch) {
    branchList.shift()
  }

  return branchList
}

/**
 * @function swap
 * @description Simple support utility for sorting arrays
 *
 * @param arr
 * @param first_Index
 * @param second_Index
 */
function swap(arr: string[], index1: number, index2: number) {
  const temp = arr[index1]
  arr[index1] = arr[index2]
  arr[index2] = temp
}

/**
 * @function isBiggerThan
 * @description Compare the semantic versions v1 > v2 ?
 *
 * @param v1
 * @param v2
 */
function isBiggerThan(v1: number[], v2: number[]): boolean {
  for (let i = 0; i < 5; i++) {
    if (v1[i] === v2[i]) {
      continue
    } else if (v1[i] > v2[i]) {
      return true
    } else {
      return false
    }
  }
  return false
}

/**
 * @function semanticVersionToArray
 * @description Translate the 'string' type version to a normalized (5 digits) 'number' type array
 *  Example
 *     input: "release/1.1-rc.1"
 *    output: [1,1,0,3,1]
 *
 * @param vStr
 */
function semanticVersionToArray(vStr: string): number[] {
  const preRelease = new Map<string, number>()
  preRelease.set('alpha', 1)
  preRelease.set('beta', 2)
  preRelease.set('rc', 3)

  const av: number[] = []
  // 1.1.rc.1
  // "release/1.1-rc.1"  -->  ['1','1-rc','1']
  const avTemp = vStr.split('/')[1].split('.')

  avTemp.forEach(function (v, index) {
    // if version contains a 'pre-release' tag
    if (v.includes('-')) {
      const vTemp: string[] = v.split('-')
      if (index === 1) {
        // short version number - 1.1-rc
        av.splice(index, 1, parseInt(vTemp[0], 10))
        av.splice(index + 1, 1, 0)
        av.splice(index + 2, 0, preRelease.get(vTemp[1])!)
      } else {
        // full version number - 1.1.0-rc
        av.splice(index, 1, parseInt(vTemp[0], 10))
        av.splice(index + 1, 0, preRelease.get(vTemp[1])!)
      }
    } else {
      av.push(parseInt(v))
    }
  })

  // make sure we get the standard length (5), fill with 0
  if (av.length < 4) { av[3] = 0 }
  if (av.length < 5) { av[4] = 0 }
  // [1,1,0,3,1]
  return av
}
