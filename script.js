const API = "https://api.jikan.moe/v4";

async function loadTrending(){

const res = await fetch(API + "/top/anime");
const data = await res.json();

const container = document.getElementById("trending");

if(!container) return;

data.data.slice(0,12).forEach(anime=>{

container.innerHTML += `
<div class="card" onclick="openAnime(${anime.mal_id})">
<img src="${anime.images.jpg.image_url}">
<p>${anime.title}</p>
</div>
`;

});

}

loadTrending();


async function searchAnime(){

const query = document.getElementById("search").value;

const res = await fetch(API + "/anime?q=" + query);

const data = await res.json();

const container = document.getElementById("results");

container.innerHTML = "";

data.data.forEach(anime=>{

container.innerHTML += `
<div class="card" onclick="openAnime(${anime.mal_id})">
<img src="${anime.images.jpg.image_url}">
<p>${anime.title}</p>
</div>
`;

});

}


function openAnime(id){

window.location = "anime.html?id=" + id;

}


async function loadAnime(){

const params = new URLSearchParams(window.location.search);

const id = params.get("id");

if(!id) return;

const res = await fetch(API + "/anime/" + id);

const data = await res.json();

const anime = data.data;

document.getElementById("anime").innerHTML = `
<h1>${anime.title}</h1>
<img src="${anime.images.jpg.image_url}">
<p>${anime.synopsis}</p>
`;

const epContainer = document.getElementById("episodes");

for(let i=1;i<=12;i++){

epContainer.innerHTML += `
<a href="watch.html?ep=${i}">
Episode ${i}
</a><br>
`;

}

}

loadAnime();
