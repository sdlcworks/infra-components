import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const runtime = fileURLToPath(new URL("runtime", import.meta.url));
const program = `
import importlib.util, io, json, os, sys
class Body:
 def __init__(self,b): self.b=b
 def read(self): return self.b
class Error(Exception):
 response={"Error":{"Code":"PreconditionFailed"}}
class S3:
 def __init__(self): self.o={}
 def put_object(self, Bucket, Key, Body, IfNoneMatch, Metadata=None):
  if (Bucket,Key) in self.o: raise Error()
  self.o[(Bucket,Key)]=Body
 def get_object(self, Bucket, Key): return {"Body":Body(self.o[(Bucket,Key)])}
def load(name):
 p=os.path.join(sys.argv[1],name+'.py'); s=importlib.util.spec_from_file_location(name,p); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
s=S3(); adapter=load('destination_adapter')
probe={"kind":"qualification","version":1,"adapterVersionArn":"arn:aws:lambda:us-east-1:123456789012:function:adapter:3","probeIdentity":"p","bucket":"b","prefix":"r","key":"qualification/p.json","association":{"runDigest":"r","configurationDigest":"c","archiveSha256":"a","treeSha256":"t","runnerSha256":"x"}}
assert adapter.handler(probe,object(),s)=={"qualified":True}
payload={"version":1,"runId":"run","functionVersionArn":"arn:aws:lambda:us-east-1:123456789012:function:task:7","terminal":{"bucket":"b","prefix":"r","maximumRecordBytes":131072}}
event={"requestContext":{"functionArn":payload["functionVersionArn"],"requestId":"req","condition":"Success"},"requestPayload":payload,"responseContext":{"statusCode":200,"functionError":None}}
assert adapter.handler(event,object(),s)=={"recorded":True}
try:
 event["requestPayload"]["runId"]="other"; adapter.handler(event,object(),s); raise AssertionError('duplicate accepted')
except ValueError: pass
print('PASS lambda protocol fixtures')
`;
const result = spawnSync("python3", ["-c", program, runtime], { encoding: "utf8" });
if (result.status !== 0) throw new Error(result.stderr || result.stdout);
process.stdout.write(result.stdout);
