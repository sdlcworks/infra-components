import { BatchGetBuildsCommand,ListBuildsForProjectCommand } from "@aws-sdk/client-codebuild";
import { taskProviderRefusal } from "@sdlcworks/components/task";
import type { AwsCodeBuildDependencies } from "./client";
import type { AwsCodeBuildRunState } from "./schema";
export const variables=(build:any)=>Object.fromEntries((build.environment?.environmentVariables??[]).map((v:any)=>[v.name,v.value]));
export function associationMatches(build:any,state:AwsCodeBuildRunState){const v=variables(build);return build.projectName===state.projectName&&v.SDLC_TASK_RUN_DIGEST&&v.SDLC_TASK_PROJECT_DIGEST===state.projectShapeDigest&&v.SDLC_TASK_DELIVERY_DIGEST===state.deliveryDigest;}
export async function recoverBuild(d:AwsCodeBuildDependencies,state:AwsCodeBuildRunState){let token: string|undefined;const ids:string[]=[];do{const page=await d.codebuild.send(new ListBuildsForProjectCommand({projectName:state.projectName,sortOrder:"DESCENDING",nextToken:token}));ids.push(...(page.ids??[]));token=page.nextToken}while(token);const matches:any[]=[];for(let i=0;i<ids.length;i+=100){const out=await d.codebuild.send(new BatchGetBuildsCommand({ids:ids.slice(i,i+100)}));matches.push(...(out.builds??[]).filter((b:any)=>associationMatches(b,state)))}if(matches.length>1)throw taskProviderRefusal("aws-codebuild-launch-association-conflict",null);return matches[0]??null;}
