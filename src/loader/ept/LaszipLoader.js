import {XHRFactory} from "../../XHRFactory.js";

let names = {
	'position': 'position',
	'color': 'color',
	'intensity': 'intensity',
	'classification': 'classification',
	'returnNumber': 'returnNumber',
	'numberOfReturns': 'numberOfReturns',
	'pointSounceID': 'pointSourceID',
	'indices': 'indices'
}

let constructors = {
	'position': Float32Array,
	'color': Uint8Array,
	'intensity': Float32Array,
	'classification': Uint8Array,
	'returnNumber': Uint8Array,
	'numberOfReturns': Uint8Array,
	'pointSounceID': Uint16Array,
	'indices': Uint8Array
}

let strides = {
	'position': 3,
	'color': 4,
	'intensity': 1,
	'classification': 1,
	'returnNumber': 1,
	'numberOfReturns': 1,
	'pointSounceID': 1,
	'indices': 4
}

/**
 * laslaz code taken and adapted from plas.io js-laslaz
 *	  http://plas.io/
 *	https://github.com/verma/plasio
 *
 * Thanks to Uday Verma and Howard Butler
 *
 */

export class EptLaszipLoader {
	async load(node) {
		if (node.loaded) return;

		let url = node.url() + '.laz';

		let req = await fetch (url);
		let buffer = await req.arrayBuffer();

		await this.parse(node, buffer);
	}

	async parse(node, buffer){
		let lf = new LASFile(buffer);

		let open = await lf.open();
		lf.isOpen = true;

		let header = await lf.getHeader();

		let i = 0;
		let np = header.pointsCount;

		let toArray = (v) => [v.x, v.y, v.z];
		let mins = toArray(node.key.b.min);
		let maxs = toArray(node.key.b.max);

		while (true) {
			let data = await lf.readData(1000000, 0, 1);

			let d = new LASDecoder(
					data.buffer,
					header.pointsFormatId,
					header.pointsStructSize,
					data.count,
					header.scale,
					header.offset,
					mins,
					maxs);
			d.extraBytes = header.extraBytes;
			d.pointsFormatId = header.pointsFormatId;
			await this.push(node, d);

			i += data.count;

			if (!data.hasMoreData) {
				header.totalRead = i;
				header.versionAsString = lf.versionAsString;
				header.isCompressed = lf.isCompressed;
				
				break;
			}
		}

		await lf.close();
		lf.isOpen = false;
	}

	async push(node, las) {
		let message = {
			buffer: las.arrayb,
			numPoints: las.pointsCount,
			pointSize: las.pointSize,
			pointFormatID: las.pointsFormatId,
			scale: las.scale,
			offset: las.offset,
			mins: las.mins,
			maxs: las.maxs
		};

		let e = await Potree.workerPool.job(Potree.scriptPath + '/workers/EptLaszipDecoderWorker.js', message, [message.buffer])

		let g = new THREE.BufferGeometry();
		let numPoints = las.pointsCount;

		let parent = node.parent;

		if (parent && parent.geometry){
			let min = parent.boundingBox.min;
			let max = parent.boundingBox.max;
			let size = [max.x - min.x, max.y - min.y, max.z - min.z];

			let pos = parent.geometry.attributes.position.array;
			let i;
			for (i = 0; i < 8; i++) if (parent.children[i] == node) break;

			if (i < 8){
				let count = 0;

				let index = (i & 2) | ((i & 1) << 2) | ((i & 4) >> 2);
				let arrays = [];

				for (let ii = 0; ii < pos.length; ii += 3){
					if (index == ((pos[ii] >= 0.5 ? 1 : 0) | (pos[ii + 1] >= 0.5 ? 2 : 0) | (pos[ii + 2] >= 0.5 ? 4 : 0))){
						count++;
					}
				}

				for (let o in e.data){
					if (!constructors[o]) continue;

					let pnode = parent.geometry.attributes[names[o]].array;
					let oarray = new constructors[o](e.data[o]);
					let narray = new constructors[o](oarray.length + count * strides[o])
					narray.set(oarray);

					e.data[o] = narray.buffer;

					let obj = {
						parray: pnode,
						array: narray,
						index: oarray.length,
						stride: strides[o],
						pos: o == 'position',
						indices: o == 'indices' && new Uint32Array(narray.buffer)
					};

					if (obj.pos){
						arrays.splice(0, 0, obj);
					}else{
						arrays.push(obj);
					}
				}

				let xoff = (index & 1) ? -0.5 : 0;
				let yoff = (index & 2) ? -0.5 : 0;
				let zoff = (index & 4) ? -0.5 : 0;

				for (let ii = 0; ii < pos.length / 3; ii++){
					if (index == ((pos[ii * 3] >= 0.5 ? 1 : 0) | (pos[ii * 3 + 1] >= 0.5 ? 2 : 0) | (pos[ii * 3 + 2] >= 0.5 ? 4 : 0))){
						for (let p of arrays){
							let off = ii * p.stride;

							if (p.indices){
								p.indices[p.index >> 2] = p.index >> 2;
								p.index += 4;
							}else if (p.pos){
								p.array[p.index++] = (p.parray[off + 0] + xoff) * size[0]
								p.array[p.index++] = (p.parray[off + 1] + yoff) * size[1]
								p.array[p.index++] = (p.parray[off + 2] + zoff) * size[2]
							}else{
								for (let iv = 0; iv < p.stride; iv++){
									p.array[p.index++] = p.parray[off + iv]
								}
							}
						}
					}
				}
			}
		}

		for (let o in e.data){
			if (!constructors[o]) continue;
			
			if (o == 'position'){
				let positions = new Float32Array(e.data.position);

				{
					let min = node.boundingBox.min;
					let max = node.boundingBox.max;

					let off = [0, 0, 0]
					let size = [max.x - min.x, max.y - min.y, max.z - min.z];

					for (let i = 0; i < positions.length; i += 3){
						let x = positions[i + 0];
						let y = positions[i + 1];
						let z = positions[i + 2];

						positions[i + 0] = (x - off[0]) / size[0];
						positions[i + 1] = (y - off[1]) / size[1];
						positions[i + 2] = (z - off[2]) / size[2];
					}
				}
			}
				
			g.addAttribute(names[o], new THREE.BufferAttribute(new constructors[o](e.data[o]), strides[o]))
		}

		g.attributes.indices.normalized = true;
		g.attributes.color.normalized = true;

		let tightBoundingBox = new THREE.Box3(
			new THREE.Vector3(0, 0, 0),
			new THREE.Vector3(1, 1, 1)
		);

		node.doneLoading(
				g,
				tightBoundingBox,
				numPoints,
				new THREE.Vector3(...e.data.mean));
	}
}