// When the user scrolls, execute myfunction
window.onscroll = function() {myFunction()};

// Get navigation bar
var navbar = document.getElementById('navbar');

// Get offset position of the bar
var sticky = navbar.offsetTop;
console.log(sticky);

// Add sticky class when scroll position is reached, remove when you 
// leave the scroll position 
function myFunction() {
	if(window.pageYOffset >= sticky) {
		navbar.classList.add("sticky");
	}
	else {
		navbar.classList.remove("sticky");
	}
}
