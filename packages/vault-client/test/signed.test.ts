import {test,expect,vi} from 'vitest';
import {Principal} from '@icp-sdk/core/principal';
import {SignedMutations,ephemeralSigner} from '../src/signed.ts';
import type {GrantInfo,VaultActor} from '../src/contracts.ts';
import {Session} from '../src/session.ts';
test('ambiguous mutation retries exact bytes, prohibits another request and wipes signer on lock',async()=>{
 const calls:Uint8Array[]=[];
 const mutate=vi.fn(async(p:Uint8Array)=>{calls.push(p.slice());if(calls.length===1)throw Error('network');return {Ok:{Unit:null}};});
 const {keys}=await ephemeralSigner();
 const grant:GrantInfo={id:new Uint8Array(32),expires:BigInt(Math.floor(Date.now()/1000)+300),next_counter:0n,purpose:{Normal:null},generations:[]};
 const signed=new SignedMutations({mutate} as unknown as Pick<VaultActor,'mutate'>,Principal.fromText('rrkah-fqaaa-aaaaa-aaaaq-cai'),Principal.fromText('ryjl3-tyaaa-aaaaa-aaaba-cai'),grant,keys);
 const op={RemoveCredential:{credential:new Uint8Array([1])}};
 await expect(signed.send(op)).rejects.toThrow('network');
 await expect(signed.send(op)).rejects.toThrow('ResolvePendingMutation');
 await signed.retry();expect(calls[0]).toEqual(calls[1]);
 const session=new Session();session.signer=signed;session.lock();await expect(signed.send(op)).rejects.toThrow('GrantExpired');
});
