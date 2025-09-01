import type { ComponentType, GlobalSession, MainModule, Module, Session } from '../media/slang-wasm.d.ts';
import playgroundSource from "./slang/playground.slang?raw";
import renderingSource from "./slang/rendering.slang?raw";
import printingSource from "./slang/printing.slang?raw";
import type { HashedStringData, ScalarType, ReflectionParameter, ReflectionJSON, Bindings, Shader, Result, CompileRequest, CompileTarget } from 'slang-playground-shared'
import type { SpirvTools } from '../media/spirv-tools.d.ts';
import { ACCESS_MAP, getTextureFormat, webgpuFormatfromSlangFormat } from './compilationUtils.js';

export function isWholeProgramTarget(compileTarget: CompileTarget) {
	return compileTarget == "METAL" || compileTarget == "SPIRV" || compileTarget == "WGSL";
}

export const PLAYGROUND_SOURCE_FILES: { [key: string]: string } = {
	"playground": playgroundSource,
	"rendering": renderingSource,
	"printing": printingSource,
};

export class SlangCompiler {
	static SLANG_STAGE_VERTEX = 1;
	static SLANG_STAGE_FRAGMENT = 5;
	static SLANG_STAGE_COMPUTE = 6;

	globalSlangSession: GlobalSession | null = null;

	compileTargetMap: { name: CompileTarget, value: number }[] | null = null;

	slangWasmModule: MainModule;

	spirvToolsModule: SpirvTools | null = null;

	constructor(module: MainModule) {
		this.slangWasmModule = module;
	}

	init(): Result<undefined> {
		try {
			this.globalSlangSession = this.slangWasmModule.createGlobalSession();
			this.compileTargetMap = this.slangWasmModule.getCompileTargets();

			if (!this.globalSlangSession || !this.compileTargetMap) {
				const error = this.slangWasmModule.getLastError();
				return { succ: false, message: (error.type + " error: " + error.message), log: error.type + " error: " + error.message };
			} else {
				return { succ: true, result: undefined };
			}
		} catch (e) {
			return { succ: false, message: '' + e, log: '' + e };
		}
	}

	findCompileTarget(compileTargetStr: CompileTarget) {
		if (this.compileTargetMap == null)
			throw new Error("No compile targets to find");
		for (let i = 0; i < this.compileTargetMap.length; i++) {
			const target = this.compileTargetMap[i];
			if (target.name == compileTargetStr)
				return target.value;
		}
		return 0;
	}

	findEntryPoint(module: Module, entryPointName: string, stage: number): Result<Module> {
		const entryPoint = module.findAndCheckEntryPoint(entryPointName, stage);
		if (!entryPoint) {
			const error = this.slangWasmModule.getLastError();
			return {
				succ: false,
				message: (error.type + " error: see log for more information"),
				log: error.message.toString(),
			};
		}
		return { succ: true, result: entryPoint };
	}

	async initSpirvTools(spirvToolsInitializer: () => Promise<SpirvTools>) {
		if (!this.spirvToolsModule) {
			this.spirvToolsModule = await spirvToolsInitializer();
		}
	}

	spirvDisassembly(spirvBinary: any): Result<string> {
		if (!this.spirvToolsModule)
			throw new Error("Spirv tools not initialized");
		let disAsmCode = this.spirvToolsModule.dis(
			spirvBinary,
			this.spirvToolsModule.SPV_ENV_UNIVERSAL_1_3,
			this.spirvToolsModule.SPV_BINARY_TO_TEXT_OPTION_INDENT |
			this.spirvToolsModule.SPV_BINARY_TO_TEXT_OPTION_FRIENDLY_NAMES
		);


		if (disAsmCode == "Error") {
			return {
				succ: false,
				message: "Error disassembling SPIR-V code",
			};
		}

		return {
			succ: true,
			result: disAsmCode,
		};
	}

	// Find whether user code also defines other entry points, if it has
	// we will also add them to the dropdown list.
	findDefinedEntryPoints(shaderSource: string, shaderPath: string): Result<string[]> {
		let result: string[] = [];
		let runnable: string[] = [];

		const split_dir = shaderPath.split('/');
		split_dir.pop();
		const dir = split_dir.join('/')
		let slangSession: Session | null | undefined;
		try {
			slangSession = this.globalSlangSession?.createSession(
				this.findCompileTarget("SPIRV"));
			if (!slangSession) {
				return {
					succ: false,
					message: "Unable to create Slang session for SPIRV compilation",
					log: this.slangWasmModule.getLastError().message.toString(),
				};
			}
			let module: Module | null = null;
			for (const [filename, content] of Object.entries(PLAYGROUND_SOURCE_FILES)) {
				slangSession.loadModuleFromSource(content, filename, dir + `/${filename}.slang`);
			}
			module = slangSession.loadModuleFromSource(shaderSource, "user", dir + "/user.slang");
			if (!module) {
				const error = this.slangWasmModule.getLastError();
				return {
					succ: false,
					message: (error.type + " error: see log for more information"),
					log: error.type + " error: " + error.message
				};
			}

			const count = module.getDefinedEntryPointCount();
			for (let i = 0; i < count; i++) {
				const entryPoint = module.getDefinedEntryPoint(i);
				result.push(entryPoint.getName());
			}
		} catch (e: any) {
			return {
				succ: false,
				message: "Error finding defined entry points",
				log: e.message
			};
		}
		finally {
			if (slangSession)
				slangSession.delete();
		}
		result.push(...runnable);
		return {
			succ: true,
			result: result
		};
	}

	addActiveEntryPoints(
		slangSession: Session,
		shaderSource: string,
		shaderPath: string,
		entryPointName: string | null,
		isWholeProgram: boolean,
		userModule: Module,
		componentList: Module[]
	): Result<true> {
		if (entryPointName == null && !isWholeProgram) {
			return {
				succ: false,
				message: "No entry point specified",
			};
		}

		// If entry point is provided, we know for sure this is not a whole program compilation,
		// so we will just go to find the correct module to include in the compilation.
		if (entryPointName != null && !isWholeProgram) {
			// we know the entry point is from user module
			const entryPointResult = this.findEntryPoint(userModule, entryPointName, SlangCompiler.SLANG_STAGE_COMPUTE);
			if (!entryPointResult.succ) {
				return entryPointResult;
			}
			componentList.push(entryPointResult.result);
		} else {
			// otherwise, it's a whole program compilation, we will find all active entry points in the user code
			// and pre-built modules.
			const resultsResult = this.findDefinedEntryPoints(shaderSource, shaderPath);
			if (!resultsResult.succ) {
				return resultsResult;
			}
			const results = resultsResult.result;
			for (let i = 0; i < results.length; i++) {
				const entryPointResult = this.findEntryPoint(userModule, results[i], SlangCompiler.SLANG_STAGE_COMPUTE);
				if (!entryPointResult.succ) {
					return entryPointResult;
				}
				componentList.push(entryPointResult.result);
			}
		}
		return { succ: true, result: true };
	}

	getBindingDescriptor(name: string, parameterReflection: ReflectionParameter): Partial<GPUBindGroupLayoutEntry> {
		if (parameterReflection.type.kind == "resource") {
			if (parameterReflection.type.baseShape == "texture2D") {
				let slangAccess = parameterReflection.type.access;
				if (slangAccess == undefined) {
					return { texture: {} };
				}
				let access = ACCESS_MAP[slangAccess];

				let scalarType: ScalarType;
				let componentCount: 1 | 2 | 3 | 4;
				if (parameterReflection.type.resultType.kind == "scalar") {
					componentCount = 1;
					scalarType = parameterReflection.type.resultType.scalarType;
				} else if (parameterReflection.type.resultType.kind == "vector") {
					componentCount = parameterReflection.type.resultType.elementCount;
					if (parameterReflection.type.resultType.elementType.kind != "scalar") throw new Error(`Unhandled inner type for ${name}`)
					scalarType = parameterReflection.type.resultType.elementType.scalarType;
				} else {
					throw new Error(`Unhandled inner type for ${name}`)
				}

				let format: GPUTextureFormat;
				if (parameterReflection.format) {
					format = webgpuFormatfromSlangFormat(parameterReflection.format);
				} else {
					try {
						format = getTextureFormat(componentCount, scalarType, access);
					} catch (e) {
						if (e instanceof Error)
							throw new Error(`Could not get texture format for ${name}: ${e.message}`)
						else
							throw new Error(`Could not get texture format for ${name}`)
					}
				}

				return { storageTexture: { access, format } };
			} else if (parameterReflection.type.baseShape == "structuredBuffer") {
				// WebGPU is strict about buffer binding types and requires exact matches:
				// - StructuredBuffer<T> (read-only) requires { buffer: { type: 'read-only-storage' } }
				// - RWStructuredBuffer<T> (read-write) requires { buffer: { type: 'storage' } }
				// Mismatched binding types will cause WebGPU validation errors and webview crashes.
				const isReadWrite = parameterReflection.type.access === "readWrite";
				return { buffer: { type: isReadWrite ? 'storage' : 'read-only-storage' } };
			} else {
				let _: never = parameterReflection.type;
				throw new Error(`Could not generate binding for ${name}`)
				return {}
			}
		} else if (parameterReflection.type.kind == "samplerState") {
			return { sampler: {} };
		} else if (parameterReflection.binding.kind == "uniform") {
			return { buffer: { type: 'uniform' } };
		} else {
			throw new Error(`Could not generate binding for ${name}`)
			return {}
		}
	}

	getResourceBindings(reflectionJson: ReflectionJSON): Bindings {
		let resourceDescriptors: Bindings = {};
		for (let parameter of reflectionJson.parameters) {
			const name = parameter.name;
			let binding = {
				binding: parameter.binding.kind == "descriptorTableSlot" ? parameter.binding.index : 0,
				visibility: GPUShaderStage.COMPUTE,
			};

			let parameterReflection = reflectionJson.parameters.find((p) => p.name == name)

			if (parameterReflection == undefined) {
				throw new Error("Could not find parameter in reflection JSON")
			}

			const resourceInfo = this.getBindingDescriptor(name, parameterReflection);

			// extend binding with resourceInfo
			Object.assign(binding, resourceInfo);

			resourceDescriptors[name] = binding;
		}

		return resourceDescriptors;
	}

	loadModule(slangSession: Session, moduleName: string, modulePath: string, source: string, componentTypeList: Module[]): Result<true> {
		let module: Module | null = slangSession.loadModuleFromSource(source, moduleName, modulePath);
		if (!module) {
			const error = this.slangWasmModule.getLastError();
			return { succ: false, message: error.type + " error. See log for more information", log: error.type + " error: " + error.message };
		}
		componentTypeList.push(module);
		return { succ: true, result: true };
	}

	async compile(request: CompileRequest, shaderPath: string, workspaceURIs: string[], spirvToolsInitializer: () => Promise<SpirvTools>): Promise<Result<Shader>> {
		const compileTarget = this.findCompileTarget(request.target);
		let isWholeProgram = isWholeProgramTarget(request.target);

		if (!compileTarget) {
			return {
				succ: false,
				message: "unknown compile target: " + request.sourceCode
			};
		}

		const split_dir = shaderPath.split('/');
		split_dir.pop();
		const dir = split_dir.join('/')

		try {
			if (this.globalSlangSession == null) {
				return {
					succ: false,
					message: "Slang session not available. Maybe the compiler hasn't been initialized yet?",
				};
			}
			let slangSession = this.globalSlangSession.createSession(compileTarget);
			if (!slangSession) {
				let error = this.slangWasmModule.getLastError();
				return {
					succ: false,
					message: (error.type + " error: " + error.message),
				};
			}

			let components: Module[] = [];

			let userModuleIndex = 0;
			const userResult = this.loadModule(slangSession, "user", `${dir}/user.slang`, request.sourceCode, components);
			if (!userResult.succ)
				return {
					succ: false,
					message: `Unable to load user module: ${userResult.message}`,
					log: userResult.log
				};
			const entryPointsResult = this.addActiveEntryPoints(slangSession, request.sourceCode, shaderPath, request.entrypoint, isWholeProgram, components[userModuleIndex], components);
			if (!entryPointsResult.succ)
				return entryPointsResult;
			let program: ComponentType = slangSession.createCompositeComponentType(components);
			let linkedProgram: ComponentType = program.link();

			let outCode: string;
			if (request.target == "SPIRV") {
				await this.initSpirvTools(spirvToolsInitializer);
				const spirvCode = linkedProgram.getTargetCodeBlob(
					0 /* targetIndex */
				);
				const disAsmResult = this.spirvDisassembly(spirvCode);
				if (!disAsmResult.succ) {
					return disAsmResult;
				}
				outCode = disAsmResult.result;
			}
			else {
				if (isWholeProgram)
					outCode = linkedProgram.getTargetCode(0);
				else
					outCode = linkedProgram.getEntryPointCode(
						0 /* entryPointIndex */, 0 /* targetIndex */);
			}

			let reflectionJson: ReflectionJSON = linkedProgram.getLayout(0)?.toJsonObject();
			let hashedStrings: HashedStringData = reflectionJson.hashedStrings ? Object.fromEntries(Object.entries(reflectionJson.hashedStrings).map(entry => entry.reverse())) : {};

			let bindings: Bindings = request.noWebGPU ? {} : this.getResourceBindings(reflectionJson);

			// remove incorrect uniform bindings
			let has_uniform_been_binded = false;
			for (let parameterReflection of reflectionJson.parameters) {
				if (parameterReflection.binding.kind != "uniform") continue;

				has_uniform_been_binded = true;
				delete bindings[parameterReflection.name];
			}

			if (has_uniform_been_binded) {
				bindings["uniformInput"] = {
					binding: 0,
					visibility: GPUShaderStage.COMPUTE,
					buffer: { type: "uniform" }
				};
			}

			// Also read the shader work-group sizes.
			let threadGroupSizes: { [key: string]: [number, number, number] } = {};
			for (const entryPoint of reflectionJson.entryPoints) {
				threadGroupSizes[entryPoint.name] = entryPoint.threadGroupSize;
			}

			if (!outCode || outCode == "") {
				let error = this.slangWasmModule.getLastError();
				return {
					succ: false,
					message: `${error.type} error: ${error.message}`,
					log: error.type + " error: " + error.message
				};
			}

			if (slangSession)
				slangSession.delete();

			return {
				succ: true,
				result: {
					code: outCode,
					layout: bindings,
					hashedStrings: hashedStrings,
					reflection: reflectionJson,
					threadGroupSizes: threadGroupSizes,
				}
			};
		} catch (e) {
			// typescript is missing the type for WebAssembly.Exception
			if (typeof e === 'object' && e !== null && e.constructor.name === 'Exception') {
				return {
					succ: false,
					message: "Slang internal error occurred.",
					log: String(e)
				};
			} else if (e instanceof Error) {
				return {
					succ: false,
					message: e.message,
					log: e.stack || e.message
				};
			}
			return {
				succ: false,
				message: "Unknown error occurred",
				log: String(e)
			};
		}
	}
};